CREATE TABLE IF NOT EXISTS ai_agent_sticker_groups (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  emotion text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,group_key),
  UNIQUE(agent_id,emotion)
);
CREATE TABLE IF NOT EXISTS ai_agent_stickers (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES ai_agent_sticker_groups(id) ON DELETE CASCADE,
  sticker_key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  storage_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,sticker_key)
);
CREATE INDEX IF NOT EXISTS ai_agent_stickers_active ON ai_agent_stickers(agent_id,group_id,sticker_key) WHERE is_active=true;
CREATE TABLE IF NOT EXISTS message_ai_stickers (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  sticker_id text NOT NULL REFERENCES ai_agent_stickers(id) ON DELETE RESTRICT
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_direct_messages_content_check' AND conrelid='ai_direct_messages'::regclass AND pg_get_constraintdef(oid) LIKE '%>= 0%') THEN
    ALTER TABLE ai_direct_messages DROP CONSTRAINT IF EXISTS ai_direct_messages_content_check;
    ALTER TABLE ai_direct_messages ADD CONSTRAINT ai_direct_messages_content_check CHECK (length(content) BETWEEN 0 AND 4000);
  END IF;
END $$;
ALTER TABLE ai_direct_messages ADD COLUMN IF NOT EXISTS sticker_id text REFERENCES ai_agent_stickers(id) ON DELETE RESTRICT;
