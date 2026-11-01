CREATE TABLE IF NOT EXISTS expression_groups (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('emoji','sticker')),
  name text NOT NULL,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','builtin')),
  builtin_key text UNIQUE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(server_id,kind,name)
);
ALTER TABLE expression_assets ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE expression_assets ADD COLUMN IF NOT EXISTS group_id text REFERENCES expression_groups(id) ON DELETE SET NULL;
ALTER TABLE expression_assets ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;
ALTER TABLE expression_assets ADD COLUMN IF NOT EXISTS builtin_key text UNIQUE;
CREATE INDEX IF NOT EXISTS expression_groups_server ON expression_groups(server_id,kind,sort_order,name);
CREATE UNIQUE INDEX IF NOT EXISTS expression_groups_active_name ON expression_groups(server_id,kind,lower(name));
