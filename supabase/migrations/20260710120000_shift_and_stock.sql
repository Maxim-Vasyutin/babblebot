-- Migration: v1.2 — Смены и учёт остатков
-- Идемпотентна: безопасно запускать повторно.

-- ===========================================================================
-- 1. Таблица shifts
-- ===========================================================================

CREATE TABLE IF NOT EXISTS shifts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  started_by  TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Открытая смена может быть только одна — физически, через БД.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_single_open
  ON shifts (ended_at) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_shifts_started ON shifts(started_at DESC);

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
-- deny-all: доступ только через service-role.

COMMENT ON TABLE shifts IS 'Смена — период учёта заказов, остатков и спроса.';
COMMENT ON COLUMN shifts.note IS 'Точка/локация. Задел на вторую АЗС.';

-- ===========================================================================
-- 2. Bootstrap-смена (без неё бот не примет ни одного заказа)
-- ===========================================================================

INSERT INTO shifts (started_at, started_by, note)
  SELECT NOW(), 'system', 'миграция v1.2'
  WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE ended_at IS NULL);

-- ===========================================================================
-- 3. menu_items: stock_qty → stock, убрать reserved_qty
-- ===========================================================================

-- Если stock_qty существует — переименовываем в stock
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'menu_items' AND column_name = 'stock_qty'
  ) THEN
    ALTER TABLE menu_items RENAME COLUMN stock_qty TO stock;
  END IF;
END$$;

-- Если stock всё ещё не существует — добавляем (для чистой БД)
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 5 CHECK (stock >= 0);

-- Убираем reserved_qty (reserve-модель упразднена)
ALTER TABLE menu_items
  DROP COLUMN IF EXISTS reserved_qty;

COMMENT ON COLUMN menu_items.stock IS
  'Физический остаток. Декрементируется при заказе, возвращается при отмене (только той же смены).';
COMMENT ON COLUMN menu_items.available IS
  'Ручной рубильник. Клиент видит позицию при available = true AND stock > 0.';

-- Индекс под клиентское меню
DROP INDEX IF EXISTS idx_menu_items_available;
CREATE INDEX IF NOT EXISTS idx_menu_items_sellable
  ON menu_items(sort_order) WHERE available = true AND stock > 0;

-- ===========================================================================
-- 4. Убрать старые RPC reserve-модели
-- ===========================================================================

DROP FUNCTION IF EXISTS reserve_stock(JSONB);
DROP FUNCTION IF EXISTS release_reserved(JSONB);
DROP FUNCTION IF EXISTS return_reserved(JSONB);

-- ===========================================================================
-- 5. orders: добавить shift_id
-- ===========================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);

-- Привязать существующие заказы к bootstrap-смене
UPDATE orders
  SET shift_id = (SELECT id FROM shifts WHERE ended_at IS NULL LIMIT 1)
  WHERE shift_id IS NULL;

COMMENT ON COLUMN orders.shift_id IS
  'Смена заказа. Нужен для /стат и для правила возврата остатка только внутри своей смены.';

-- ===========================================================================
-- 6. demand_events: kind → reason, добавить shift_id, значение not_carried → unavailable
-- ===========================================================================

-- Добавить reason, если ещё не переименовали
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'demand_events' AND column_name = 'kind'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'demand_events' AND column_name = 'reason'
  ) THEN
    ALTER TABLE demand_events RENAME COLUMN kind TO reason;
  END IF;
END$$;

-- Добавить reason с дефолтом, если не существует
ALTER TABLE demand_events
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'unavailable';

-- Переименовать устаревшее значение not_carried → unavailable
UPDATE demand_events SET reason = 'unavailable' WHERE reason = 'not_carried';

-- Добавить shift_id
ALTER TABLE demand_events
  ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_demand_events_shift ON demand_events(shift_id);
CREATE INDEX IF NOT EXISTS idx_demand_events_slug  ON demand_events(slug);

COMMENT ON COLUMN demand_events.reason IS
  'sold_out — позиция кончилась (stock=0); unavailable — снята вручную или не в каталоге.';

-- ===========================================================================
-- 7. Убрать demand_clicks (если осталась с первых миграций)
-- ===========================================================================

DROP TABLE IF EXISTS demand_clicks;
DROP FUNCTION IF EXISTS bump_demand(TEXT, TEXT);

-- ===========================================================================
-- 8. RPC: start_shift — атомарное открытие смены
-- ===========================================================================

CREATE OR REPLACE FUNCTION start_shift(p_started_by TEXT)
RETURNS UUID AS $$
DECLARE
  new_id UUID;
BEGIN
  UPDATE shifts SET ended_at = NOW() WHERE ended_at IS NULL;

  INSERT INTO shifts (started_by) VALUES (p_started_by) RETURNING id INTO new_id;

  UPDATE menu_items
    SET stock = 5, available = true, updated_at = NOW()
    WHERE field_item = true;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION start_shift IS
  'Закрывает текущую смену, открывает новую, сбрасывает остатки в 5 шт на полевые позиции.';

-- ===========================================================================
-- 9. RPC: decrement_stock — атомарное списание корзины
-- ===========================================================================

CREATE OR REPLACE FUNCTION decrement_stock(p_items JSONB)
RETURNS TEXT[] AS $$
DECLARE
  item     JSONB;
  failed   TEXT[] := ARRAY[]::TEXT[];
  affected INTEGER;
BEGIN
  -- Порядок по slug — защита от взаимных блокировок при параллельных заказах
  FOR item IN
    SELECT * FROM jsonb_array_elements(p_items) e
    ORDER BY (e->>'slug')
  LOOP
    UPDATE menu_items
      SET stock = stock - (item->>'qty')::int, updated_at = NOW()
      WHERE slug = item->>'slug'
        AND available = true
        AND stock >= (item->>'qty')::int;

    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected = 0 THEN
      failed := array_append(failed, item->>'slug');
    END IF;
  END LOOP;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'insufficient_stock:%', array_to_string(failed, ',');
  END IF;

  RETURN failed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================================================
-- 10. RPC: cancel_order — отмена с возвратом остатка (только своя смена)
-- ===========================================================================

CREATE OR REPLACE FUNCTION cancel_order(p_order_id UUID, p_handled_by TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  o_items   JSONB;
  o_shift   UUID;
  cur_shift UUID;
  item      JSONB;
BEGIN
  SELECT id INTO cur_shift FROM shifts WHERE ended_at IS NULL LIMIT 1;

  UPDATE orders
    SET status = 'cancelled', handled_by = p_handled_by, updated_at = NOW()
    WHERE id = p_order_id AND status IN ('new', 'in_progress')
    RETURNING items, shift_id INTO o_items, o_shift;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Заказ прошлой смены: статус меняем, остатки текущей не трогаем
  IF o_shift IS DISTINCT FROM cur_shift THEN
    RETURN TRUE;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(o_items) LOOP
    UPDATE menu_items
      SET stock = stock + (item->>'qty')::int, updated_at = NOW()
      WHERE slug = item->>'slug';
  END LOOP;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================================================
-- 11. RPC: bump_demand — запись события спроса
-- ===========================================================================

CREATE OR REPLACE FUNCTION bump_demand(
  p_slug    TEXT,
  p_title   TEXT,
  p_user_id BIGINT,
  p_reason  TEXT
) RETURNS VOID AS $$
DECLARE
  cur_shift UUID;
BEGIN
  SELECT id INTO cur_shift FROM shifts WHERE ended_at IS NULL LIMIT 1;
  INSERT INTO demand_events (slug, title, user_id, shift_id, reason)
    VALUES (p_slug, p_title, p_user_id, cur_shift, p_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
