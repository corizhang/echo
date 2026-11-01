-- Replace squad-wide user uploads with two scopes: system defaults and
-- uploader-owned personal libraries. Keep server_id for tenant membership and
-- history access; Echo currently provisions a single squad.
ALTER TABLE expression_assets ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';
ALTER TABLE expression_assets DROP CONSTRAINT IF EXISTS expression_assets_scope_check;
ALTER TABLE expression_assets ADD CONSTRAINT expression_assets_scope_check CHECK (scope IN ('system','personal'));
UPDATE expression_assets SET scope=CASE WHEN is_builtin THEN 'system' ELSE 'personal' END;

ALTER TABLE expression_groups ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';
ALTER TABLE expression_groups ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE expression_groups DROP CONSTRAINT IF EXISTS expression_groups_scope_check;
ALTER TABLE expression_groups ADD CONSTRAINT expression_groups_scope_check CHECK (scope IN ('system','personal'));
UPDATE expression_groups SET scope=CASE WHEN source='builtin' THEN 'system' ELSE 'personal' END,
  owner_user_id=CASE WHEN source='user' THEN created_by ELSE NULL END;

DROP INDEX IF EXISTS expression_assets_active_name;
CREATE UNIQUE INDEX IF NOT EXISTS expression_assets_system_active_name
  ON expression_assets(server_id,kind,lower(name)) WHERE deleted_at IS NULL AND scope='system';
CREATE UNIQUE INDEX IF NOT EXISTS expression_assets_personal_active_name
  ON expression_assets(server_id,owner_user_id,kind,lower(name)) WHERE deleted_at IS NULL AND scope='personal';
DROP INDEX IF EXISTS expression_groups_active_name;
ALTER TABLE expression_groups DROP CONSTRAINT IF EXISTS expression_groups_server_id_kind_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS expression_groups_system_active_name
  ON expression_groups(server_id,kind,lower(name)) WHERE scope='system';
CREATE UNIQUE INDEX IF NOT EXISTS expression_groups_personal_active_name
  ON expression_groups(server_id,owner_user_id,kind,lower(name)) WHERE scope='personal';

-- Existing bot packs remain attached to their bot. New system packs use a NULL
-- agent_id and are inherited by every agent.
ALTER TABLE ai_agent_sticker_groups ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE ai_agent_stickers ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE ai_agent_sticker_groups ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'agent';
ALTER TABLE ai_agent_sticker_groups ADD COLUMN IF NOT EXISTS server_id text REFERENCES servers(id) ON DELETE CASCADE;
ALTER TABLE ai_agent_stickers ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'agent';
ALTER TABLE ai_agent_stickers ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id) ON DELETE SET NULL;
UPDATE ai_agent_sticker_groups g SET server_id=a.server_id FROM ai_agents a WHERE g.agent_id=a.id AND g.server_id IS NULL;
ALTER TABLE ai_agent_sticker_groups DROP CONSTRAINT IF EXISTS ai_agent_sticker_groups_scope_check;
ALTER TABLE ai_agent_sticker_groups ADD CONSTRAINT ai_agent_sticker_groups_scope_check CHECK (scope IN ('system','agent'));
ALTER TABLE ai_agent_stickers DROP CONSTRAINT IF EXISTS ai_agent_stickers_scope_check;
ALTER TABLE ai_agent_stickers ADD CONSTRAINT ai_agent_stickers_scope_check CHECK (scope IN ('system','agent'));
DROP INDEX IF EXISTS ai_agent_stickers_active;
ALTER TABLE ai_agent_sticker_groups DROP CONSTRAINT IF EXISTS ai_agent_sticker_groups_agent_id_group_key_key;
ALTER TABLE ai_agent_sticker_groups DROP CONSTRAINT IF EXISTS ai_agent_sticker_groups_agent_id_emotion_key;
ALTER TABLE ai_agent_stickers DROP CONSTRAINT IF EXISTS ai_agent_stickers_agent_id_sticker_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_system_key ON ai_agent_sticker_groups(server_id,group_key) WHERE scope='system';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_agent_key ON ai_agent_sticker_groups(agent_id,group_key) WHERE scope='agent';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_agent_compat ON ai_agent_sticker_groups(agent_id,group_key);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_system_emotion ON ai_agent_sticker_groups(server_id,emotion) WHERE scope='system';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_agent_emotion ON ai_agent_sticker_groups(agent_id,emotion) WHERE scope='agent';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_sticker_groups_emotion_compat ON ai_agent_sticker_groups(agent_id,emotion);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_stickers_system_key ON ai_agent_stickers(sticker_key) WHERE scope='system';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_stickers_agent_key ON ai_agent_stickers(agent_id,sticker_key) WHERE scope='agent';
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_stickers_agent_compat ON ai_agent_stickers(agent_id,sticker_key);
CREATE INDEX IF NOT EXISTS ai_agent_stickers_active ON ai_agent_stickers(scope,agent_id,group_id,sticker_key) WHERE is_active=true;
