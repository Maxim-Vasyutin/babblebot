-- Queue Cat / Bubble Cat — initial schema
-- Источник истины: SPEC.md, Блок 2 (Data Model)
--
-- Замечание по безопасности: доступ к БД только с сервера, service-role ключом.
-- Публичного anon-клиента нет, поэтому RLS не является защитным контуром.
-- На каждой таблице RLS включена, разрешающих политик для anon/authenticated НЕТ.
-- Это deny-all для defense-in-depth. Service-role обходит RLS штатно.
--
-- Все денежные значения — INTEGER в копейках. 250 ₽ = 25000.

-- Расширение moddatetime для авто-обновления updated_at через триггер
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- ============================================================================
-- Таблица: app_settings
-- Singleton key/value настройки приложения.
-- Ключи: 'admin_chat_id' (BIGINT как текст), 'order_counter' (сквозной номер заказа).
-- ============================================================================
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
-- deny-all: политик для anon/authenticated не создаём. Доступ только service-role.

-- Сквозной счётчик заказов реализуем атомарно через UPDATE ... RETURNING (см. RPC ниже),
-- начальное значение:
INSERT INTO app_settings (key, value) VALUES ('order_counter', '0')
  ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Таблица: menu_items
-- Каталог позиций. Полевые 6 позиций сидируются как available=true.
-- Позиции "сегодня нет" (для статистики спроса) владелец добавляет позже как
-- available=false, field_item=false.
-- ============================================================================
CREATE TABLE menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,          -- стабильный ключ для callback_data, напр. 'ice_latte'
  title TEXT NOT NULL,                -- 'Айс-латте'
  price_kop INTEGER NOT NULL DEFAULT 0 CHECK (price_kop >= 0),
  variant_group TEXT CHECK (variant_group IN ('syrup', 'tea')), -- NULL = без вариантов
  field_item BOOLEAN NOT NULL DEFAULT false, -- true = входит в полевое меню дня
  available BOOLEAN NOT NULL DEFAULT false,  -- true = сейчас в наличии
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menu_items_available ON menu_items(available) WHERE available = true;
CREATE INDEX idx_menu_items_field ON menu_items(field_item);
CREATE INDEX idx_menu_items_sort ON menu_items(sort_order);

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
-- deny-all.

CREATE TRIGGER menu_items_moddatetime
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- СИД полевого меню (6 позиций из фото-меню, все available=true, field_item=true)
INSERT INTO menu_items (slug, title, price_kop, variant_group, field_item, available, sort_order) VALUES
  ('sour_lemonade', 'Кислый лимонад',      25000, NULL,    true, true, 10),
  ('ice_latte',     'Айс-латте',           25000, 'syrup', true, true, 20),
  ('coffee_tonic',  'Кофе-тоник',          23000, NULL,    true, true, 30),
  ('cold_tea',      'Холодный чай',        20000, 'tea',   true, true, 40),
  ('sand_cheese',   'Сэндвич сыр-ветчина', 25000, NULL,    true, true, 50),
  ('sand_chicken',  'Сэндвич с курочкой',  25000, NULL,    true, true, 60);

-- ============================================================================
-- Таблица: user_sessions
-- FSM-состояние диалога + корзина. Ключ — Telegram user_id (BIGINT).
-- Serverless: между запросами нет памяти, поэтому весь диалог живёт здесь.
-- ============================================================================
CREATE TABLE user_sessions (
  user_id BIGINT PRIMARY KEY,          -- Telegram from.id
  username TEXT,                        -- @username на момент последнего апдейта (может быть NULL)
  state TEXT NOT NULL DEFAULT 'browsing'
    CHECK (state IN ('browsing','choosing_variant','cart',
                     'checkout_landmark','checkout_landmark_text',
                     'checkout_car','checkout_payment')),
  context JSONB NOT NULL DEFAULT '{}'::jsonb, -- временные данные шага (напр. выбранный slug, ориентир)
  cart JSONB NOT NULL DEFAULT '[]'::jsonb,    -- массив строк корзины
  last_car TEXT,                        -- последняя машина для быстрого повтора
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_updated ON user_sessions(updated_at);

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
-- deny-all.

CREATE TRIGGER user_sessions_moddatetime
  BEFORE UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================================
-- Таблица: orders
-- Заказы. items — JSONB-снапшот корзины на момент оформления (намеренно
-- не нормализуем в order_items — заказ должен навсегда сохранить, что именно
-- и по какой цене куплено, даже если позицию в menu_items потом переименуют).
-- user_id — Telegram from.id (BIGINT), НЕ FK на auth.users (Supabase Auth не используется).
-- ============================================================================
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number INTEGER NOT NULL,        -- сквозной человекочитаемый номер (#7)
  user_id BIGINT NOT NULL,              -- Telegram from.id (не FK на auth.users)
  username TEXT,
  items JSONB NOT NULL,                 -- снапшот корзины на момент заказа
  total_kop INTEGER NOT NULL CHECK (total_kop >= 0),
  landmark TEXT NOT NULL,               -- 'Середина очереди' или произвольный текст
  car TEXT NOT NULL,                    -- 'белая гранта а123вс'
  payment_method TEXT NOT NULL CHECK (payment_method IN ('sbp','cash','terminal')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','in_progress','delivered','cancelled')),
  admin_message_id BIGINT,              -- id карточки в admin-чате (для editMessageText)
  handled_by TEXT,                      -- @username курьера, менявшего статус
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_number ON orders(order_number);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- deny-all.

CREATE TRIGGER orders_moddatetime
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================================
-- Таблица: demand_clicks
-- Счётчик «хочу 👀» по позициям, которых нет в наличии.
-- Отдельная таблица (а не поле в menu_items), чтобы считать спрос и по позициям,
-- которых ещё нет в каталоге (владелец может завести их позже; в MVP пишем по slug).
-- ============================================================================
CREATE TABLE demand_clicks (
  slug TEXT PRIMARY KEY,       -- ключ позиции (может ссылаться на menu_items.slug или быть новым)
  title TEXT NOT NULL,         -- человекочитаемое имя для /стат
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE demand_clicks ENABLE ROW LEVEL SECURITY;
-- deny-all.

CREATE TRIGGER demand_clicks_moddatetime
  BEFORE UPDATE ON demand_clicks
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================================
-- RPC: атомарный сквозной номер заказа
-- Гонки между параллельными serverless-вызовами закрываем атомарным UPDATE.
-- ============================================================================
CREATE OR REPLACE FUNCTION next_order_number()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE app_settings
    SET value = (value::int + 1)::text, updated_at = NOW()
    WHERE key = 'order_counter'
    RETURNING value::int INTO n;
  RETURN n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: атомарный инкремент спроса
-- ============================================================================
CREATE OR REPLACE FUNCTION bump_demand(p_slug TEXT, p_title TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO demand_clicks (slug, title, clicks)
    VALUES (p_slug, p_title, 1)
    ON CONFLICT (slug)
    DO UPDATE SET clicks = demand_clicks.clicks + 1, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
