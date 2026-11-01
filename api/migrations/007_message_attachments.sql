ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_content_check CHECK (length(content) <= 4000);

CREATE TABLE IF NOT EXISTS message_attachments (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id text REFERENCES messages(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS message_attachments_owner_pending ON message_attachments(owner_user_id, created_at) WHERE message_id IS NULL;
