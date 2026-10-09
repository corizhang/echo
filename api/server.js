import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'
import { WebSocketServer } from 'ws'
import { AccessToken } from 'livekit-server-sdk'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const { Pool } = pg
const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })
const subscriber = redis.duplicate()
const PORT = Number(process.env.PORT || 3000)
const USER_ID = 'user-lin'
const USER_NAME = 'Lin'
const EVENT_CHANNEL = 'echo.events'
const sockets = new Set()

app.use(express.json({ limit: '1mb' }))
app.use((_, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)

async function publish(type, data) {
  const event = { type, serverTime: new Date().toISOString(), data }
  await redis.publish(EVENT_CHANNEL, JSON.stringify(event))
  return event
}

subscriber.on('error', (error) => console.error('Redis subscriber:', error.message))
redis.on('error', (error) => console.error('Redis:', error.message))

app.get('/health', asyncRoute(async (_, res) => {
  await db.query('SELECT 1')
  await redis.ping()
  res.json({ ok: true })
}))

app.get('/api/v1/me', asyncRoute(async (_, res) => {
  const { rows } = await db.query('SELECT id, username, display_name AS "displayName", avatar, color, status, activity FROM users WHERE id=$1', [USER_ID])
  res.json(rows[0])
}))

app.get('/api/v1/servers', asyncRoute(async (_, res) => {
  const { rows } = await db.query(`SELECT s.id, s.name, s.initials, s.color FROM servers s JOIN server_members m ON m.server_id=s.id WHERE m.user_id=$1 ORDER BY s.id`, [USER_ID])
  res.json(rows)
}))

app.get('/api/v1/servers/:serverId/channels', asyncRoute(async (req, res) => {
  const { rows } = await db.query('SELECT id, server_id AS "serverId", name, type, topic FROM channels WHERE server_id=$1 ORDER BY type, created_at, id', [req.params.serverId])
  res.json(rows)
}))

app.post('/api/v1/servers/:serverId/channels', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, '-')
  const type = req.body.type === 'voice' ? 'voice' : 'text'
  if (!name) return res.status(400).json({ error: '频道名称不能为空' })
  const id = `channel-${randomUUID()}`
  const { rows } = await db.query('INSERT INTO channels(id, server_id, name, type, topic) VALUES($1,$2,$3,$4,$5) RETURNING id, server_id AS "serverId", name, type, topic', [id, req.params.serverId, name, type, req.body.topic || '新建频道'])
  await publish('channel.created', rows[0])
  res.status(201).json(rows[0])
}))

app.get('/api/v1/servers/:serverId/members', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`SELECT u.id, u.username, u.display_name AS "displayName", u.avatar, u.color, u.status, u.activity FROM users u JOIN server_members m ON m.user_id=u.id WHERE m.server_id=$1 ORDER BY u.id`, [req.params.serverId])
  res.json(rows)
}))

app.get('/api/v1/channels/:channelId/messages', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`SELECT m.id, m.channel_id AS "channelId", m.author_id AS "authorId", u.display_name AS author, u.avatar, u.color, m.content, m.reply_to AS "replyTo", m.pinned, m.created_at AS "createdAt" FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 ORDER BY m.created_at, m.id`, [req.params.channelId])
  const ids = rows.map((item) => item.id)
  if (ids.length) {
    const reactions = await db.query(`SELECT message_id AS "messageId", emoji, count(*)::int AS count, bool_or(user_id=$2) AS reacted FROM reactions WHERE message_id=ANY($1::text[]) GROUP BY message_id, emoji ORDER BY emoji`, [ids, USER_ID])
    const grouped = new Map()
    for (const reaction of reactions.rows) { const list = grouped.get(reaction.messageId) || []; list.push({ emoji: reaction.emoji, count: reaction.count, reacted: reaction.reacted }); grouped.set(reaction.messageId, list) }
    rows.forEach((message) => { message.reactions = grouped.get(message.id) || [] })
    const replies = rows.filter((message) => message.replyTo?.id)
    for (const reply of replies) {
      const { rows: parent } = await db.query('SELECT m.id, m.content, u.display_name AS author FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id=$1', [reply.replyTo.id])
      if (parent[0]) reply.replyTo = { ...reply.replyTo, ...parent[0] }
    }
  }
  res.json(rows)
}))

app.post('/api/v1/channels/:channelId/messages', asyncRoute(async (req, res) => {
  const content = String(req.body.content || '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ error: '消息长度需为 1 到 4000 个字符' })
  const id = `m-${randomUUID()}`
  const replyTo = req.body.replyTo?.id ? JSON.stringify({ id: req.body.replyTo.id }) : null
  const { rows } = await db.query(`INSERT INTO messages(id,channel_id,author_id,content,reply_to) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id, channel_id AS "channelId", author_id AS "authorId", content, reply_to AS "replyTo", pinned, created_at AS "createdAt"`, [id, req.params.channelId, USER_ID, content, replyTo])
  const message = { ...rows[0], author: USER_NAME, avatar: 'L', color: 'blue', reactions: [] }
  await publish('message.created', message)
  res.status(201).json(message)
}))

app.put('/api/v1/messages/:messageId/reactions/:emoji', asyncRoute(async (req, res) => {
  const emoji = decodeURIComponent(req.params.emoji)
  const result = await db.query('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3 RETURNING message_id', [req.params.messageId, USER_ID, emoji])
  if (!result.rowCount) await db.query('INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3)', [req.params.messageId, USER_ID, emoji])
  const { rows } = await db.query('SELECT id, channel_id AS "channelId" FROM messages WHERE id=$1', [req.params.messageId])
  if (!rows[0]) return res.status(404).json({ error: '找不到消息' })
  await publish('message.updated', { id: rows[0].id, channelId: rows[0].channelId })
  res.json({ ok: true })
}))

app.put('/api/v1/messages/:messageId/pin', asyncRoute(async (req, res) => {
  const { rows } = await db.query('UPDATE messages SET pinned=NOT pinned WHERE id=$1 RETURNING id, channel_id AS "channelId", pinned', [req.params.messageId])
  if (!rows[0]) return res.status(404).json({ error: '找不到消息' })
  await publish('message.updated', rows[0]); res.json(rows[0])
}))

app.post('/api/v1/voice/token', asyncRoute(async (req, res) => {
  const { rows } = await db.query("SELECT id FROM channels WHERE id=$1 AND type='voice'", [req.body.channelId])
  if (!rows[0]) return res.status(404).json({ error: '语音频道不存在' })
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: USER_ID, name: USER_NAME, ttl: '1h' })
  token.addGrant({ roomJoin: true, room: rows[0].id, canPublish: true, canSubscribe: true })
  res.json({ url: process.env.LIVEKIT_URL, token: await token.toJwt(), room: rows[0].id, expiresAt: new Date(Date.now() + 3600000).toISOString() })
}))

app.post('/api/v1/voice/presence', asyncRoute(async (req, res) => {
  const presence = { userId: USER_ID, channelId: req.body.channelId, connected: Boolean(req.body.connected), updatedAt: new Date().toISOString() }
  await publish('voice.presence', presence); res.json(presence)
}))

app.use((error, _, res, __) => {
  console.error(error)
  res.status(error.code === '23505' ? 409 : error.code === '23503' ? 404 : 500).json({ error: error.code === '23505' ? '频道名称已存在' : '服务器处理请求时发生错误' })
})

wss.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/v1/events') return socket.destroy()
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

async function start() {
  await db.query('SELECT 1')
  await redis.connect()
  await subscriber.connect()
  await subscriber.subscribe(EVENT_CHANNEL, (message) => {
    for (const socket of sockets) if (socket.readyState === 1) socket.send(message)
  })
  server.listen(PORT, '0.0.0.0', () => console.log(`Echo API listening on ${PORT}`))
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await subscriber.quit(); await redis.quit(); await db.end(); process.exit(0) })
start().catch((error) => { console.error(error); process.exit(1) })
