ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS voice_replies_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE ai_direct_messages
  ADD COLUMN IF NOT EXISTS audio_storage_key text,
  ADD COLUMN IF NOT EXISTS audio_mime_type text,
  ADD COLUMN IF NOT EXISTS audio_size_bytes integer,
  ADD COLUMN IF NOT EXISTS audio_duration_ms integer,
  ADD COLUMN IF NOT EXISTS audio_file_name text;

CREATE TABLE IF NOT EXISTS ai_tts_credentials (
  server_id text PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 500),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  voice text NOT NULL CHECK (length(voice) BETWEEN 1 AND 100),
  encrypted_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_suffix text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX IF NOT EXISTS ai_direct_messages_audio
  ON ai_direct_messages(conversation_id, created_at DESC)
  WHERE audio_storage_key IS NOT NULL;
