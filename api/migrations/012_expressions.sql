CREATE TABLE IF NOT EXISTS expression_assets (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('emoji','sticker')),
  name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS expression_assets_active_name ON expression_assets(server_id,kind,lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS expression_assets_server ON expression_assets(server_id,kind,created_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS message_stickers (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  expression_id text NOT NULL REFERENCES expression_assets(id) ON DELETE RESTRICT
);
