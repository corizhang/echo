ALTER TABLE ai_tts_credentials
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'openai-compatible',
  ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT 'seed-tts-2.0';

ALTER TABLE ai_tts_credentials
  DROP CONSTRAINT IF EXISTS ai_tts_credentials_provider_check;

ALTER TABLE ai_tts_credentials
  ADD CONSTRAINT ai_tts_credentials_provider_check
  CHECK (provider IN ('openai-compatible', 'doubao'));

ALTER TABLE ai_tts_credentials
  DROP CONSTRAINT IF EXISTS ai_tts_credentials_resource_id_check;

ALTER TABLE ai_tts_credentials
  ADD CONSTRAINT ai_tts_credentials_resource_id_check
  CHECK (length(resource_id) BETWEEN 1 AND 100);
