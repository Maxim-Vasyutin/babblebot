-- Индекс для экрана «Мои заказы»: последние N заказов клиента.
-- Без индекса выборка пойдёт seq scan по всей таблице orders.
CREATE INDEX IF NOT EXISTS idx_orders_user_recent
  ON orders(user_id, created_at DESC);

COMMENT ON INDEX idx_orders_user_recent IS
  'Экран "Мои заказы": последние 3 заказа клиента по user_id.';
