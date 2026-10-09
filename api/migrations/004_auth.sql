ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_user ON auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE game_room_members ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE SET NULL;
UPDATE game_room_members m SET user_id='user-lin'
FROM game_rooms r
WHERE m.room_id=r.id AND m.id=r.host_member_id AND m.user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS game_room_active_member_user
  ON game_room_members(room_id, user_id)
  WHERE user_id IS NOT NULL AND status <> 'left';
