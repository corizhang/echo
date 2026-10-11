import { createGameRelay } from './game-relay.js'
import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'
import { WebSocketServer } from 'ws'
import { AccessToken } from 'livekit-server-sdk'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'

const { Pool } = pg
const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const gameRelay = createGameRelay(db)
const redis = createClient({ url: process.env.REDIS_URL })
const subscriber = redis.duplicate()
const PORT = Number(process.env.PORT || 3000)
const EVENT_CHANNEL = 'echo.events'
const sockets = new Set()
const hashSecret = (value) => createHash('sha256').update(value).digest('hex')
const scrypt = promisify(scryptCallback)
const authAttempts = new Map()

// Only the bundled Windows desktop origin may access the local API cross-origin.
app.use((req, res, next) => {
  if (req.headers.origin === 'http://tauri.localhost') {
    res.setHeader('Access-Control-Allow-Origin', 'http://tauri.localhost')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Echo-Game-Session')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
  }
  next()
})
app.use(express.json({ limit: '1mb' }))
app.use((_, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)

async function createPasswordHash(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$16384$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`
}
async function verifyPassword(password, encoded) {
  const [algorithm, cost, saltText, keyText] = String(encoded || '').split('$')
  if (algorithm !== 'scrypt' || cost !== '16384' || !saltText || !keyText) return false
  try {
    const expected = Buffer.from(keyText, 'base64url')
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}
async function provisionTestAccounts() {
  for (const account of [{ username: 'lin', id: 'user-lin', env: 'ECHO_TEST_LIN_PASSWORD' }, { username: 'mori', id: 'user-mori', env: 'ECHO_TEST_MORI_PASSWORD' }]) {
    const password = process.env[account.env]
    if (!password || password.length < 16 || password === 'replace-with-a-long-random-password') throw new Error(`${account.env} must be set to a unique password of at least 16 characters`)
    const { rows } = await db.query('SELECT id,password_hash AS "passwordHash" FROM users WHERE username=$1', [account.username])
    if (rows[0]?.id !== account.id) throw new Error(`Expected seeded test account ${account.username}`)
    if (!await verifyPassword(password, rows[0].passwordHash)) {
      await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [account.id])
      await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [account.id, await createPasswordHash(password)])
    }
  }
}
async function authenticate(req, res, next) {
  const match = req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)
  if (!match) return res.status(401).json({ error: '请先登录' })
  try {
    const { rows } = await db.query(`SELECT u.id, u.username, u.display_name AS "displayName", u.avatar, u.color, u.status, u.activity
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [hashSecret(match[1])])
    if (!rows[0]) return res.status(401).json({ error: '登录已过期，请重新登录' })
    req.authUser = rows[0]; next()
  } catch (error) { next(error) }
}

async function publish(type, data) {
  const event = { type, serverTime: new Date().toISOString(), data }
  await redis.publish(EVENT_CHANNEL, JSON.stringify(event))
  return event
}

async function getGameRoom(roomId) {
  const { rows } = await db.query(`SELECT id, server_id AS "serverId", title, game_version AS "gameVersion", map_name AS "mapName", status, voice_room_id AS "voiceRoomId", host_member_id AS "hostMemberId", invite_expires_at AS "inviteExpiresAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM game_rooms WHERE id=$1`, [roomId])
  if (!rows[0]) return null
  const { rows: members } = await db.query(`SELECT id, display_name AS "displayName", role, status, joined_at AS "joinedAt", last_seen_at AS "lastSeenAt" FROM game_room_members WHERE room_id=$1 AND status <> 'left' ORDER BY joined_at`, [roomId])
  return { ...rows[0], members }
}

async function requireGameMember(req, roomId) {
  const token = req.get('X-Echo-Game-Session')
  if (!token) return null
  const { rows } = await db.query(`SELECT m.id, m.room_id AS "roomId", m.display_name AS "displayName", m.role, m.status FROM game_room_members m JOIN game_rooms r ON r.id=m.room_id WHERE m.room_id=$1 AND m.session_token_hash=$2 AND m.status <> 'left' AND r.status <> 'closed'`, [roomId, hashSecret(token)])
  if (!rows[0]) return null
  await db.query('UPDATE game_room_members SET last_seen_at=now() WHERE id=$1', [rows[0].id])
  return rows[0]
}

function cleanDisplayName(value) {
  return String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 32)
}

function liveKitUrlForRequest(req) {
  if (process.env.LIVEKIT_URL) return process.env.LIVEKIT_URL
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const secure = (forwardedProto || req.protocol) === 'https'
  return `${secure ? 'wss' : 'ws'}://${req.get('host')}`
}

subscriber.on('error', (error) => console.error('Redis subscriber:', error.message))
redis.on('error', (error) => console.error('Redis:', error.message))

app.get('/health', asyncRoute(async (_, res) => {
  await db.query('SELECT 1')
  await redis.ping()
  res.json({ ok: true })
}))

app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  const key = `${req.ip}:${username}`; const now = Date.now(); const attempt = authAttempts.get(key)
  if (attempt?.blockedUntil > now) return res.status(429).json({ error: '登录尝试过多，请稍后再试' })
  const { rows } = await db.query(`SELECT id,username,display_name AS "displayName",avatar,color,status,activity,password_hash AS "passwordHash" FROM users WHERE username=$1 AND id IN ('user-lin','user-mori')`, [username])
  if (!await verifyPassword(password, rows[0]?.passwordHash)) {
    const inWindow = attempt?.windowStart > now - 15*60*1000
    const count = inWindow ? attempt.count + 1 : 1
    authAttempts.set(key, { count, windowStart: inWindow ? attempt.windowStart : now, blockedUntil: count >= 5 ? now + 15*60*1000 : 0 })
    return res.status(401).json({ error: '用户名或密码不正确' })
  }
  authAttempts.delete(key)
  const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(now + 7*24*60*60*1000)
  await db.query('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [`session-${randomUUID()}`, rows[0].id, hashSecret(token), expiresAt])
  delete rows[0].passwordHash
  res.json({ token, expiresAt: expiresAt.toISOString(), user: rows[0] })
}))

app.use('/api/v1', authenticate)
app.post('/api/v1/auth/logout', asyncRoute(async (req, res) => {
  const token = req.get('Authorization').slice(7)
  await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hashSecret(token)])
  for (const socket of sockets) if (socket.userId === req.authUser.id) socket.close(1008, 'Signed out')
  res.json({ ok: true })
}))
app.get('/api/v1/me', (req, res) => res.json(req.authUser))

app.get('/api/v1/servers', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`SELECT s.id, s.name, s.initials, s.color FROM servers s JOIN server_members m ON m.server_id=s.id WHERE m.user_id=$1 ORDER BY s.id`, [req.authUser.id])
  res.json(rows)
}))

app.get('/api/v1/servers/:serverId/channels', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个小队' })
  const { rows } = await db.query('SELECT id, server_id AS "serverId", name, type, topic FROM channels WHERE server_id=$1 ORDER BY type, created_at, id', [req.params.serverId])
  res.json(rows)
}))

app.post('/api/v1/servers/:serverId/channels', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个小队' })
  const name = String(req.body.name || '').trim().replace(/\s+/g, '-')
  const type = req.body.type === 'voice' ? 'voice' : 'text'
  if (!name) return res.status(400).json({ error: '频道名称不能为空' })
  const id = `channel-${randomUUID()}`
  const { rows } = await db.query('INSERT INTO channels(id, server_id, name, type, topic) VALUES($1,$2,$3,$4,$5) RETURNING id, server_id AS "serverId", name, type, topic', [id, req.params.serverId, name, type, req.body.topic || '新建频道'])
  await publish('channel.created', rows[0])
  res.status(201).json(rows[0])
}))

app.get('/api/v1/servers/:serverId/members', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个小队' })
  const { rows } = await db.query(`SELECT u.id, u.username, u.display_name AS "displayName", u.avatar, u.color, u.status, u.activity FROM users u JOIN server_members m ON m.user_id=u.id WHERE m.server_id=$1 AND u.password_hash IS NOT NULL ORDER BY u.id`, [req.params.serverId])
  res.json(rows)
}))

app.get('/api/v1/channels/:channelId/messages', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND m.user_id=$2', [req.params.channelId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个频道' })
  const { rows } = await db.query(`SELECT m.id, m.channel_id AS "channelId", m.author_id AS "authorId", u.display_name AS author, u.avatar, u.color, m.content, m.reply_to AS "replyTo", m.pinned, m.created_at AS "createdAt" FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 ORDER BY m.created_at, m.id`, [req.params.channelId])
  const ids = rows.map((item) => item.id)
  if (ids.length) {
    const reactions = await db.query(`SELECT message_id AS "messageId", emoji, count(*)::int AS count, bool_or(user_id=$2) AS reacted FROM reactions WHERE message_id=ANY($1::text[]) GROUP BY message_id, emoji ORDER BY emoji`, [ids, req.authUser.id])
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
  const access = await db.query('SELECT 1 FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND m.user_id=$2', [req.params.channelId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个频道' })
  const content = String(req.body.content || '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ error: '消息长度需为 1 到 4000 个字符' })
  const id = `m-${randomUUID()}`
  const replyTo = req.body.replyTo?.id ? JSON.stringify({ id: req.body.replyTo.id }) : null
  const { rows } = await db.query(`INSERT INTO messages(id,channel_id,author_id,content,reply_to) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id, channel_id AS "channelId", author_id AS "authorId", content, reply_to AS "replyTo", pinned, created_at AS "createdAt"`, [id, req.params.channelId, req.authUser.id, content, replyTo])
  const message = { ...rows[0], author: req.authUser.displayName, avatar: req.authUser.avatar, color: req.authUser.color, reactions: [] }
  await publish('message.created', message)
  res.status(201).json(message)
}))

app.put('/api/v1/messages/:messageId/reactions/:emoji', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM messages msg JOIN channels c ON c.id=msg.channel_id JOIN server_members m ON m.server_id=c.server_id WHERE msg.id=$1 AND m.user_id=$2', [req.params.messageId, req.authUser.id])
  if (!access.rowCount) return res.status(404).json({ error: '找不到消息' })
  const emoji = decodeURIComponent(req.params.emoji)
  const result = await db.query('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3 RETURNING message_id', [req.params.messageId, req.authUser.id, emoji])
  if (!result.rowCount) await db.query('INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3)', [req.params.messageId, req.authUser.id, emoji])
  const { rows } = await db.query('SELECT id, channel_id AS "channelId" FROM messages WHERE id=$1', [req.params.messageId])
  if (!rows[0]) return res.status(404).json({ error: '找不到消息' })
  await publish('message.updated', { id: rows[0].id, channelId: rows[0].channelId })
  res.json({ ok: true })
}))

app.put('/api/v1/messages/:messageId/pin', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM messages msg JOIN channels c ON c.id=msg.channel_id JOIN server_members m ON m.server_id=c.server_id WHERE msg.id=$1 AND m.user_id=$2', [req.params.messageId, req.authUser.id])
  if (!access.rowCount) return res.status(404).json({ error: '找不到消息' })
  const { rows } = await db.query('UPDATE messages SET pinned=NOT pinned WHERE id=$1 RETURNING id, channel_id AS "channelId", pinned', [req.params.messageId])
  if (!rows[0]) return res.status(404).json({ error: '找不到消息' })
  await publish('message.updated', rows[0]); res.json(rows[0])
}))

app.post('/api/v1/voice/token', asyncRoute(async (req, res) => {
  const { rows } = await db.query("SELECT c.id FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND c.type='voice' AND m.user_id=$2", [req.body.channelId, req.authUser.id])
  if (!rows[0]) return res.status(404).json({ error: '语音频道不存在' })
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: req.authUser.id, name: req.authUser.displayName, ttl: '1h' })
  token.addGrant({ roomJoin: true, room: rows[0].id, canPublish: true, canSubscribe: true })
  res.json({ url: liveKitUrlForRequest(req), token: await token.toJwt(), room: rows[0].id, expiresAt: new Date(Date.now() + 3600000).toISOString() })
}))

app.post('/api/v1/voice/presence', asyncRoute(async (req, res) => {
  const presence = { userId: req.authUser.id, channelId: req.body.channelId, connected: Boolean(req.body.connected), updatedAt: new Date().toISOString() }
  await publish('voice.presence', presence); res.json(presence)
}))

app.get('/api/v1/servers/:serverId/game-rooms', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '你不在这个小队中' })
  const { rows } = await db.query("SELECT id FROM game_rooms WHERE server_id=$1 AND status<>'closed' ORDER BY created_at DESC LIMIT 50", [req.params.serverId])
  res.json(await Promise.all(rows.map(({ id }) => getGameRoom(id))))
}))

app.post('/api/v1/game-rooms/:roomId/preview', asyncRoute(async (req, res) => {
  const room = await getGameRoom(req.params.roomId)
  if (!room || room.status === 'closed') return res.status(404).json({ error: '房间已结束或不存在' })
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [room.serverId, req.authUser.id])
  if (!access.rowCount) {
    const invite = await db.query('SELECT 1 FROM game_rooms WHERE id=$1 AND invite_code_hash=$2 AND invite_expires_at>now()', [room.id, hashSecret(String(req.body.inviteCode || ''))])
    if (!invite.rowCount) return res.status(403).json({ error: '邀请链接无效或已过期' })
  }
  res.json(room)
}))

app.get('/api/v1/game-rooms/:roomId/messages', asyncRoute(async (req, res) => {
  if (!await requireGameMember(req, req.params.roomId)) return res.status(403).json({ error: '加入房间后即可聊天' })
  const { rows } = await db.query(`SELECT * FROM (SELECT id, member_id AS "memberId", author, content, kind, created_at AS "createdAt" FROM game_room_messages WHERE room_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200) recent ORDER BY "createdAt", id`, [req.params.roomId])
  res.json(rows)
}))

app.post('/api/v1/game-rooms/:roomId/messages', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '加入房间后即可聊天' })
  const content = String(req.body.content || '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ error: '消息长度需为 1 到 4000 个字符' })
  await db.query('INSERT INTO game_room_messages(id,room_id,member_id,author,content) VALUES($1,$2,$3,$4,$5)', [`gm-${randomUUID()}`, req.params.roomId, member.id, member.displayName, content])
  await publish('game-room.message', { roomId: req.params.roomId })
  res.status(201).json({ ok: true })
}))

app.post('/api/v1/servers/:serverId/game-rooms', asyncRoute(async (req, res) => {
  const title = String(req.body.title || 'Warcraft III 开黑').trim().slice(0, 64)
  const mapName = String(req.body.mapName || '').trim().slice(0, 100)
  const displayName = req.authUser.displayName
  if (!title || !displayName) return res.status(400).json({ error: '房间名称和玩家昵称不能为空' })
  const { rows: servers } = await db.query('SELECT id FROM servers WHERE id=$1', [req.params.serverId])
  if (!servers[0]) return res.status(404).json({ error: '服务器不存在' })
  const roomId = `game-${randomUUID()}`
  const memberId = `player-${randomUUID()}`
  const inviteCode = randomBytes(24).toString('base64url')
  const sessionToken = randomBytes(32).toString('base64url')
  let voiceRoomId = roomId
  if (req.body.voiceChannelId) {
    const voice = await db.query("SELECT id FROM channels WHERE id=$1 AND server_id=$2 AND type='voice'", [req.body.voiceChannelId, req.params.serverId])
    if (!voice.rowCount) return res.status(400).json({ error: '语音大厅不存在' })
    const busy = await db.query("SELECT 1 FROM game_rooms WHERE voice_room_id=$1 AND status<>'closed'", [req.body.voiceChannelId])
    if (busy.rowCount) return res.status(409).json({ error: '当前大厅已有开黑房间，请直接加入' })
    voiceRoomId = voice.rows[0].id
  }
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO game_rooms(id,server_id,title,game_version,map_name,status,voice_room_id,host_member_id,invite_code_hash,invite_expires_at)
      VALUES($1,$2,$3,'1.24e',$4,'waiting',$7,$5,$6,now()+interval '7 days')`, [roomId, req.params.serverId, title, mapName, memberId, hashSecret(inviteCode), voiceRoomId])
    await client.query(`INSERT INTO game_room_members(id,room_id,user_id,display_name,role,status,session_token_hash) VALUES($1,$2,$5,$3,'host','joined',$4)`, [memberId, roomId, displayName, hashSecret(sessionToken), req.authUser.id])
    await client.query("INSERT INTO game_room_messages(id,room_id,author,content,kind) VALUES($1,$2,$3,$4,'system')", [`gm-${randomUUID()}`, roomId, displayName, `${displayName} 创建了房间`])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const room = await getGameRoom(roomId)
  await publish('game-room.updated', { roomId })
  res.status(201).json({ room, sessionToken, inviteCode })
}))

app.get('/api/v1/game-rooms/:roomId', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '房间会话无效或已结束' })
  const room = await getGameRoom(req.params.roomId)
  if (!room) return res.status(404).json({ error: '找不到游戏房间' })
  res.json({ room, memberId: member.id, role: member.role })
}))

app.post('/api/v1/game-rooms/:roomId/join', asyncRoute(async (req, res) => {
  const inviteCode = String(req.body.inviteCode || '')
  const displayName = req.authUser.displayName
  const existing = await requireGameMember(req, req.params.roomId)
  if (existing) return res.json({ room: await getGameRoom(req.params.roomId), memberId: existing.id, role: existing.role, sessionToken: req.get('X-Echo-Game-Session') })
  const client = await db.connect()
  let room
  const memberId = `player-${randomUUID()}`
  const sessionToken = randomBytes(32).toString('base64url')
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT r.id FROM game_rooms r WHERE r.id=$1 AND r.status<>'closed' AND ((r.invite_code_hash=$2 AND r.invite_expires_at>now()) OR EXISTS(SELECT 1 FROM server_members sm WHERE sm.server_id=r.server_id AND sm.user_id=$3)) FOR UPDATE`, [req.params.roomId, hashSecret(inviteCode), req.authUser.id])
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: '邀请链接已失效或房间已结束' }) }
    const sameUser = await client.query("SELECT id,role FROM game_room_members WHERE room_id=$1 AND user_id=$2 AND status<>'left' FOR UPDATE", [req.params.roomId, req.authUser.id])
    if (sameUser.rowCount) {
      await client.query('UPDATE game_room_members SET session_token_hash=$2,last_seen_at=now() WHERE id=$1', [sameUser.rows[0].id, hashSecret(sessionToken)])
      await client.query('COMMIT')
      return res.json({ room: await getGameRoom(req.params.roomId), memberId: sameUser.rows[0].id, role: sameUser.rows[0].role, sessionToken })
    }
    const { rows: [capacity] } = await client.query("SELECT count(*)::int AS total FROM game_room_members WHERE room_id=$1 AND status<>'left'", [req.params.roomId])
    if (capacity.total >= 8) { await client.query('ROLLBACK'); return res.status(409).json({ error: '游戏房间最多容纳 8 人' }) }
    await client.query(`INSERT INTO game_room_members(id,room_id,user_id,display_name,role,status,session_token_hash) VALUES($1,$2,$5,$3,'player','joined',$4)`, [memberId, req.params.roomId, displayName, hashSecret(sessionToken), req.authUser.id])
    await client.query("INSERT INTO game_room_messages(id,room_id,author,content,kind) VALUES($1,$2,$3,$4,'system')", [`gm-${randomUUID()}`, req.params.roomId, displayName, `${displayName} 加入了房间`])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  room = await getGameRoom(req.params.roomId)
  await gameRelay.reconcile(req.params.roomId)
  await publish('game-room.updated', { roomId: req.params.roomId })
  res.status(201).json({ room, memberId, role: 'player', sessionToken })
}))

app.put('/api/v1/game-rooms/:roomId/status', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '房间会话无效或已结束' })
  const memberStatus = String(req.body.memberStatus || member.status)
  if (!['joined', 'ready', 'starting', 'running'].includes(memberStatus)) return res.status(400).json({ error: '无效的玩家状态' })
  const roomStatus = req.body.roomStatus == null ? null : String(req.body.roomStatus)
  if (roomStatus && !['waiting', 'in_game', 'closed'].includes(roomStatus)) return res.status(400).json({ error: '无效的房间状态' })
  if (roomStatus && member.role !== 'host') return res.status(403).json({ error: '只有房主可以更改房间状态' })
  await db.query('UPDATE game_room_members SET status=$2,last_seen_at=now() WHERE id=$1', [member.id, memberStatus])
  if (roomStatus) await db.query('UPDATE game_rooms SET status=$2,updated_at=now() WHERE id=$1', [req.params.roomId, roomStatus])
  const room = await getGameRoom(req.params.roomId)
  await gameRelay.reconcile(req.params.roomId)
  await publish('game-room.updated', { roomId: req.params.roomId })
  res.json({ room, memberId: member.id, role: member.role })
}))

app.post('/api/v1/game-rooms/:roomId/leave', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '房间会话无效或已结束' })
  if (req.body.endRoom && member.role !== 'host') return res.status(403).json({ error: '只有房主可以结束房间' })
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM game_rooms WHERE id=$1 FOR UPDATE', [req.params.roomId])
    const { rows: [current] } = await client.query('SELECT role,status FROM game_room_members WHERE id=$1', [member.id])
    if (current.status === 'left') { await client.query('COMMIT'); return res.json({ ok: true }) }
    if (req.body.endRoom && current.role !== 'host') { await client.query('ROLLBACK'); return res.status(403).json({ error: '只有房主可以结束房间' }) }
    const next = await client.query("SELECT id FROM game_room_members WHERE room_id=$1 AND id<>$2 AND status<>'left' ORDER BY joined_at LIMIT 1", [req.params.roomId, member.id])
    if (req.body.endRoom || !next.rowCount) {
      await client.query("UPDATE game_rooms SET status='closed',updated_at=now() WHERE id=$1", [req.params.roomId])
    } else if (current.role === 'host') {
      await client.query("UPDATE game_room_members SET role='host' WHERE id=$1", [next.rows[0].id])
      await client.query('UPDATE game_rooms SET host_member_id=$2,updated_at=now() WHERE id=$1', [req.params.roomId, next.rows[0].id])
    }
    await client.query("UPDATE game_room_members SET status='left',role='player',last_seen_at=now() WHERE id=$1", [member.id])
    await client.query("INSERT INTO game_room_messages(id,room_id,author,content,kind) VALUES($1,$2,$3,$4,'system')", [`gm-${randomUUID()}`, req.params.roomId, member.displayName, `${member.displayName} ${req.body.endRoom ? '结束了房间' : '离开了房间'}`])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await gameRelay.reconcile(req.params.roomId)
  await publish('game-room.updated', { roomId: req.params.roomId })
  res.json({ ok: true })
}))

app.post('/api/v1/game-rooms/:roomId/invite', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (member?.role !== 'host') return res.status(403).json({ error: '只有房主可以创建邀请链接' })
  const inviteCode = randomBytes(24).toString('base64url')
  await db.query("UPDATE game_rooms SET invite_code_hash=$2,invite_expires_at=now()+interval '7 days' WHERE id=$1", [req.params.roomId, hashSecret(inviteCode)])
  res.json({ inviteCode })
}))

app.post('/api/v1/game-rooms/:roomId/relay-ticket', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '加入房间后才能开启联机' })
  const room = await getGameRoom(req.params.roomId)
  if (room.gameVersion !== '1.24e') return res.status(409).json({ error: '当前联机实验仅支持 1.24e' })
  res.json({ ticket: gameRelay.issue(member), roomId: room.id, expiresIn: 30 })
}))

app.post('/api/v1/game-rooms/:roomId/voice-token', asyncRoute(async (req, res) => {
  const member = await requireGameMember(req, req.params.roomId)
  if (!member) return res.status(403).json({ error: '房间会话无效或已结束' })
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: member.id, name: member.displayName, ttl: '1h' })
  const room = await getGameRoom(req.params.roomId)
  token.addGrant({ roomJoin: true, room: room.voiceRoomId, canPublish: true, canSubscribe: true })
  res.json({ url: liveKitUrlForRequest(req), token: await token.toJwt(), room: room.voiceRoomId, expiresAt: new Date(Date.now() + 3600000).toISOString() })
}))

app.use((error, _, res, __) => {
  console.error(error)
  res.status(error.code === '23505' ? 409 : error.code === '23503' ? 404 : 500).json({ error: error.code === '23505' ? '名称或语音关联已存在，请刷新后重试' : '服务器处理请求时发生错误' })
})

wss.on('connection', (socket) => {
  sockets.add(socket); const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000)
  socket.on('message', async (raw, binary) => {
    if (socket.userId || binary || raw.length > 256) return socket.close(1008, 'Invalid authentication')
    try {
      const payload = JSON.parse(raw.toString())
      if (payload.type !== 'auth' || !/^[A-Za-z0-9_-]{40,100}$/.test(payload.token || '')) return socket.close(1008, 'Authentication required')
      const { rows } = await db.query('SELECT u.id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()', [hashSecret(payload.token)])
      if (!rows[0]) return socket.close(1008, 'Session expired')
      socket.userId = rows[0].id; clearTimeout(timeout); socket.send(JSON.stringify({ type: 'authenticated' }))
    } catch { socket.close(1008, 'Authentication required') }
  })
  socket.on('close', () => { clearTimeout(timeout); sockets.delete(socket) })
})
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/api/v1/game-relay') return gameRelay.upgrade(request, socket, head)
  if (request.url !== '/api/v1/events') return socket.destroy()
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

async function start() {
  await db.query('SELECT 1')
  await db.query(await readFile(new URL('./migrations/002_game_rooms.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/003_room_messages.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/004_auth.sql', import.meta.url), 'utf8'))
  await provisionTestAccounts()
  await redis.connect()
  await subscriber.connect()
  await subscriber.subscribe(EVENT_CHANNEL, (message) => {
    for (const socket of sockets) if (socket.readyState === 1 && socket.userId) socket.send(message)
  })
  server.listen(PORT, '0.0.0.0', () => console.log(`Echo API listening on ${PORT}`))
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await subscriber.quit(); await redis.quit(); await db.end(); process.exit(0) })
start().catch((error) => { console.error(error); process.exit(1) })
