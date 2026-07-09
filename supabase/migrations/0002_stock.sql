-- v1.1 Feature 01: Stock management, demand events, atomic reservation
-- Adds stock tracking to menu_items, replaces demand_clicks with demand_events,
-- adds reserve/release/return RPCs.

-- ============================================================================
-- 1. Stock columns on menu_items
-- ============================================================================
ALTER TABLE menu_items
  ADD COLUMN stock_qty    INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  ADD COLUMN reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0);

COMMENT ON COLUMN menu_items.stock_qty    IS 'Available stock. 0 = auto-stop selling';
COMMENT ON COLUMN menu_items.reserved_qty IS 'Reserved by active orders (new/in_progress)';

-- ============================================================================
-- 2. demand_events — replaces demand_clicks
-- Events allow "today" aggregation and distinguish sold_out vs not_carried.
-- ============================================================================
CREATE TABLE demand_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  kind       TEXT        NOT NULL CHECK (kind IN ('sold_out', 'not_carried')),
  user_id    BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_demand_events_created ON demand_events(created_at);
CREATE INDEX idx_demand_events_slug    ON demand_events(slug);

ALTER TABLE demand_events ENABLE ROW LEVEL SECURITY;
-- deny-all: no permissive policies for anon/authenticated. service-role only.

-- ============================================================================
-- 3. Drop old demand tracking
-- ============================================================================
DROP TABLE    IF EXISTS demand_clicks;
DROP FUNCTION IF EXISTS bump_demand(TEXT, TEXT);

-- ============================================================================
-- 4. RPC: atomic all-or-nothing stock reservation
--
-- Input: [{"slug":"ice_latte","qty":2}, ...]
-- Returns: {"ok":true} or {"ok":false,"short":[{"slug":"...","available":N}]}
-- Uses FOR UPDATE to prevent race conditions between concurrent serverless calls.
-- ============================================================================
CREATE OR REPLACE FUNCTION reserve_stock(p_items JSONB)
RETURNS JSONB AS $$
DECLARE
  item  JSONB;
  short JSONB := '[]'::jsonb;
  avail INTEGER;
BEGIN
  -- First pass: lock rows and check availability
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT stock_qty INTO avail
      FROM menu_items
      WHERE slug = item->>'slug'
      FOR UPDATE;
    IF avail IS NULL OR avail < (item->>'qty')::int THEN
      short := short || jsonb_build_object(
        'slug', item->>'slug',
        'available', COALESCE(avail, 0)
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(short) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'short', short);
  END IF;

  -- Second pass: reserve
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE menu_items
      SET stock_qty    = stock_qty    - (item->>'qty')::int,
          reserved_qty = reserved_qty + (item->>'qty')::int
      WHERE slug = item->>'slug';
  END LOOP;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 5. RPC: release reservation (order delivered — stock consumed permanently)
-- ============================================================================
CREATE OR REPLACE FUNCTION release_reserved(p_items JSONB)
RETURNS VOID AS $$
DECLARE item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE menu_items
      SET reserved_qty = GREATEST(reserved_qty - (item->>'qty')::int, 0)
      WHERE slug = item->>'slug';
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 6. RPC: return reservation (order cancelled — stock goes back)
-- ============================================================================
CREATE OR REPLACE FUNCTION return_reserved(p_items JSONB)
RETURNS VOID AS $$
DECLARE item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE menu_items
      SET reserved_qty = GREATEST(reserved_qty - (item->>'qty')::int, 0),
          stock_qty    = stock_qty + (item->>'qty')::int
      WHERE slug = item->>'slug';
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
