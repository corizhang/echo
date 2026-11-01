CREATE TABLE IF NOT EXISTS channel_read_states (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

-- Existing history is treated as already read when the feature is introduced.
INSERT INTO channel_read_states(user_id, channel_id, last_read_message_id, last_read_at)
SELECT member.user_id, channel.id, latest.id, latest.created_at
FROM channels channel
JOIN server_members member ON member.server_id = channel.server_id
LEFT JOIN LATERAL (
  SELECT id, created_at FROM messages
  WHERE channel_id = channel.id ORDER BY created_at DESC, id DESC LIMIT 1
) latest ON true
WHERE channel.type = 'text'
ON CONFLICT (user_id, channel_id) DO NOTHING;
