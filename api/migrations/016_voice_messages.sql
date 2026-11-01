ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS duration_ms integer;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='message_attachments'::regclass AND conname='message_attachments_mime_type_check' AND pg_get_constraintdef(oid) NOT LIKE '%audio/webm%') THEN
    ALTER TABLE message_attachments DROP CONSTRAINT message_attachments_mime_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='message_attachments'::regclass AND conname='message_attachments_mime_type_check') THEN
    ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_mime_type_check
      CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp','audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='message_attachments'::regclass AND conname='message_attachments_duration_check') THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='message_attachments'::regclass AND conname='message_attachments_duration_ms_check') THEN
      ALTER TABLE message_attachments DROP CONSTRAINT message_attachments_duration_ms_check;
    END IF;
    ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_duration_check
      CHECK ((mime_type LIKE 'audio/%' AND duration_ms BETWEEN 1 AND 120000) OR (mime_type LIKE 'image/%' AND duration_ms IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS message_attachments_audio_message
  ON message_attachments(message_id) WHERE mime_type LIKE 'audio/%';
