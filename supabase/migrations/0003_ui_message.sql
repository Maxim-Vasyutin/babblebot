-- v1.1 Feature 02: Single-message UI (clean dialog)
-- Stores the current bot UI message id per user session for edit-in-place rendering.

ALTER TABLE user_sessions
  ADD COLUMN ui_message_id BIGINT;

COMMENT ON COLUMN user_sessions.ui_message_id
  IS 'message_id of the current bot UI screen in the private chat; NULL = no live screen (e.g. after order confirmation)';
