ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS messages_channel_read_order
  ON messages(channel_id, created_at, id);
