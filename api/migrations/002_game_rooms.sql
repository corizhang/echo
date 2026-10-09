CREATE TABLE IF NOT EXISTS game_rooms (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 64),
  game_version text NOT NULL DEFAULT '1.24e',
  map_name text NOT NULL DEFAULT '' CHECK (length(map_name) <= 100),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_game', 'closed')),
  voice_room_id text NOT NULL UNIQUE,
  host_member_id text NOT NULL,
  invite_code_hash text NOT NULL UNIQUE,
  invite_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_room_members (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 32),
  role text NOT NULL CHECK (role IN ('host', 'player')),
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'ready', 'starting', 'running', 'left')),
  session_token_hash text NOT NULL UNIQUE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, id)
);

ALTER TABLE game_rooms DROP CONSTRAINT IF EXISTS game_rooms_host_member_fk;
ALTER TABLE game_rooms ADD CONSTRAINT game_rooms_host_member_fk
  FOREIGN KEY (id, host_member_id) REFERENCES game_room_members(room_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS game_room_members_room_idx ON game_room_members(room_id, joined_at);
CREATE INDEX IF NOT EXISTS game_rooms_server_status_idx ON game_rooms(server_id, status, updated_at DESC);
