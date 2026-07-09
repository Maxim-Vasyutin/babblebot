-- v1.1 Patch 6: Дедупликация update_id
-- Защита от повторной обработки при ретраях Telegram webhook.

CREATE TABLE processed_updates (
  update_id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE processed_updates ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE processed_updates
  IS 'Журнал обработанных update_id Telegram; INSERT ON CONFLICT DO NOTHING используется как идемпотентный гейт в вебхуке';
