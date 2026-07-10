-- live_message_id — сообщение-экран, редактируемое ботом.
-- NULL = нет живого экрана (после чека, сразу после /start до первого экрана).
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS live_message_id BIGINT;

COMMENT ON COLUMN user_sessions.live_message_id IS
  'Сообщение-экран, которое бот редактирует. Чек сюда НЕ попадает: он терминален.';

-- Добавить состояние cart_confirm_clear в FSM-проверку
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_state_check;
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_state_check
  CHECK (state IN ('browsing','choosing_variant','cart','cart_confirm_clear',
                   'checkout_landmark','checkout_landmark_text',
                   'checkout_car','checkout_payment'));
