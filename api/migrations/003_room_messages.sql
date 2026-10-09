ALTER TABLE game_rooms DROP CONSTRAINT IF EXISTS game_rooms_voice_room_id_key;
CREATE TABLE IF NOT EXISTS game_room_messages (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  member_id text REFERENCES game_room_members(id),
  author text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','system')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_room_messages_order_idx ON game_room_messages(room_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS game_rooms_active_voice_idx ON game_rooms(voice_room_id) WHERE status <> 'closed';
