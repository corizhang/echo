CREATE TABLE users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  avatar text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'blue',
  status text NOT NULL DEFAULT 'online',
  activity text
);

CREATE TABLE servers (
  id text PRIMARY KEY,
  name text NOT NULL,
  initials text NOT NULL,
  color text NOT NULL
);

CREATE TABLE server_members (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE channels (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('text', 'voice')),
  topic text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);

CREATE TABLE messages (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  reply_to jsonb,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_channel_created ON messages(channel_id, created_at);

CREATE TABLE reactions (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

INSERT INTO users (id, username, display_name, avatar, color, status, activity) VALUES
  ('user-lin', 'lin', 'Lin', 'L', 'blue', 'online', NULL),
  ('user-mori', 'mori', 'Mori', '森', 'violet', 'online', '正在玩 Valorant'),
  ('user-kira', 'kira', 'Kira', 'K', 'orange', 'online', '在语音 · 开黑大厅'),
  ('user-ache', 'ache', '阿澈', '澈', 'green', 'idle', '暂时离开');

INSERT INTO servers (id, name, initials, color) VALUES
  ('server-squad', '游戏小队', 'GG', 'purple'),
  ('server-weekend', '周末计划', '末', 'coral');

INSERT INTO server_members (server_id, user_id)
SELECT server_id, user_id FROM (VALUES
  ('server-squad', 'user-lin'), ('server-squad', 'user-mori'), ('server-squad', 'user-kira'), ('server-squad', 'user-ache'),
  ('server-weekend', 'user-lin'), ('server-weekend', 'user-mori'), ('server-weekend', 'user-ache')
) AS members(server_id, user_id);

INSERT INTO channels (id, server_id, name, type, topic) VALUES
  ('text-chat', 'server-squad', '闲聊', 'text', '今晚也要玩得开心'),
  ('text-party', 'server-squad', '游戏组队', 'text', '组队、开黑、约时间'),
  ('text-clips', 'server-squad', '战绩分享', 'text', '高光时刻请发这里'),
  ('voice-lobby', 'server-squad', '开黑大厅', 'voice', '语音房间'),
  ('text-chat-weekend', 'server-weekend', '周末安排', 'text', '计划下一次聚会'),
  ('voice-weekend', 'server-weekend', '一起玩', 'voice', '语音房间');

INSERT INTO messages (id, channel_id, author_id, content, pinned, created_at) VALUES
  ('m-1', 'text-chat', 'user-mori', '晚上好，今晚打什么？我刚把更新下完了 🎮', false, now() - interval '48 minutes'),
  ('m-2', 'text-chat', 'user-kira', '先来两把无畏契约？阿澈说他十分钟后到。', false, now() - interval '46 minutes'),
  ('m-3', 'text-chat', 'user-lin', '可以，我开个语音房，等人齐了就开。', true, now() - interval '45 minutes'),
  ('m-4', 'text-chat', 'user-mori', '好，今天争取别再输加时了 😂', false, now() - interval '44 minutes'),
  ('p-1', 'text-party', 'user-kira', '今晚 9 点排位，缺一个人，来吗？', true, now() - interval '180 minutes'),
  ('c-1', 'text-clips', 'user-mori', '昨天最后一回合的残局，差一点就五杀了。', false, now() - interval '1400 minutes'),
  ('w-1', 'text-chat-weekend', 'user-ache', '周六下午大家有空吗？可以约个饭再打游戏。', false, now() - interval '75 minutes');

INSERT INTO reactions (message_id, user_id, emoji) VALUES
  ('m-1', 'user-mori', '🎮'), ('m-1', 'user-kira', '🎮'),
  ('m-3', 'user-lin', '👍'),
  ('p-1', 'user-kira', '🙋'), ('p-1', 'user-mori', '🙋'),
  ('c-1', 'user-mori', '🔥'), ('c-1', 'user-kira', '🔥'), ('c-1', 'user-ache', '🔥');
