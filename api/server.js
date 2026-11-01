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
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { log, errorFields } from './logger.js'
import { createAiRouter, maybeGenerateAiReply } from './ai-agents.js'

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
const MAX_MESSAGE_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_VOICE_MESSAGE_DURATION_MS = 120_000
const sockets = new Set()
const hashSecret = (value) => createHash('sha256').update(value).digest('hex')
const scrypt = promisify(scryptCallback)
const authAttempts = new Map()
const uploadDir = process.env.ECHO_UPLOAD_DIR || '/app/uploads'
const IMAGE_TYPES = new Map([
  ['image/png', { extension: '.png', matches: (data) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/jpeg', { extension: '.jpg', matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['image/gif', { extension: '.gif', matches: (data) => data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii')) }],
  ['image/webp', { extension: '.webp', matches: (data) => data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' }],
])
const AUDIO_TYPES = new Map([
  ['audio/webm', { extension: '.webm', matches: (data) => data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }],
  ['audio/ogg', { extension: '.ogg', matches: (data) => data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS' }],
  ['audio/mp4', { extension: '.m4a', matches: (data) => data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp' }],
  ['audio/mpeg', { extension: '.mp3', matches: (data) => data.length >= 3 && (data.subarray(0, 3).toString('ascii') === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) }],
  ['audio/wav', { extension: '.wav', matches: (data) => data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE' }],
])

app.use((req, res, next) => {
  req.logRequestId = randomUUID()
  res.setHeader('X-Request-Id', req.logRequestId)
  next()
})

// Only the bundled Windows desktop origin may access the local API cross-origin.
app.use((req, res, next) => {
  if (req.headers.origin === 'http://tauri.localhost') {
    res.setHeader('Access-Control-Allow-Origin', 'http://tauri.localhost')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Echo-Game-Session,X-File-Name,X-Audio-Duration-Ms,X-Expression-Name,X-Expression-Kind,X-Expression-Group,X-Expression-Scope,X-Bot-Sticker-Name,X-Bot-Sticker-Emotion,X-Bot-Sticker-Description,X-Bot-Sticker-Scope')
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

async function publish(type, data, recipientUserId = null) {
  const event = { type, serverTime: new Date().toISOString(), data, ...(recipientUserId ? { recipientUserId } : {}) }
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

subscriber.on('error', (error) => log('error', 'redis_subscriber_error', errorFields(error)))
redis.on('error', (error) => log('error', 'redis_client_error', errorFields(error)))

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
  const { rows } = await db.query(`SELECT id,username,display_name AS "displayName",avatar,color,status,activity,password_hash AS "passwordHash" FROM users WHERE username=$1 AND password_hash IS NOT NULL`, [username])
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
app.use('/api/v1/ai', createAiRouter(db, publish))
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
  const { rows } = await db.query(`SELECT c.id,c.server_id AS "serverId",c.name,c.type,c.topic,
    CASE WHEN c.type='text' THEN (SELECT count(*)::int FROM messages m LEFT JOIN channel_read_states r ON r.channel_id=c.id AND r.user_id=$2
      WHERE m.channel_id=c.id AND m.deleted_at IS NULL AND (r.last_read_at IS NULL OR m.created_at>r.last_read_at OR (m.created_at=r.last_read_at AND m.id>r.last_read_message_id))) ELSE 0 END AS unread,
    CASE WHEN c.type='text' THEN (SELECT m.id FROM messages m LEFT JOIN channel_read_states r ON r.channel_id=c.id AND r.user_id=$2
      WHERE m.channel_id=c.id AND m.deleted_at IS NULL AND (r.last_read_at IS NULL OR m.created_at>r.last_read_at OR (m.created_at=r.last_read_at AND m.id>r.last_read_message_id)) ORDER BY m.created_at,m.id LIMIT 1) ELSE NULL END AS "unreadMessageId"
    FROM channels c WHERE c.server_id=$1 ORDER BY c.type,c.created_at,c.id`, [req.params.serverId, req.authUser.id])
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
  const { rows } = await db.query(`SELECT u.id, u.username, u.display_name AS "displayName", u.avatar, u.color, u.status, u.activity, u.is_bot AS "isBot" FROM users u JOIN server_members m ON m.user_id=u.id WHERE m.server_id=$1 AND (u.password_hash IS NOT NULL OR u.is_bot=true) ORDER BY u.is_bot,u.id`, [req.params.serverId])
  res.json(rows)
}))

async function hydrateMessages(rows, userId) {
  const ids = rows.map((message) => message.id)
  if (!ids.length) return rows
  const authorIds = [...new Set(rows.map((message) => message.authorId).filter(Boolean))]
  const botAuthors = authorIds.length ? await db.query('SELECT id FROM users WHERE is_bot=true AND id=ANY($1::text[])', [authorIds]) : { rows: [] }
  const botAuthorIds = new Set(botAuthors.rows.map((row) => row.id))
  const attachments = await db.query(`SELECT a.id,a.message_id AS "messageId",a.file_name AS "fileName",a.mime_type AS "mimeType",a.size_bytes AS "sizeBytes",a.duration_ms AS "durationMs" FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.message_id=ANY($1::text[]) AND m.deleted_at IS NULL ORDER BY a.created_at,a.id`, [ids])
  const attachmentMap = new Map()
  for (const attachment of attachments.rows) { const list = attachmentMap.get(attachment.messageId) || []; list.push(attachment); attachmentMap.set(attachment.messageId, list) }
  const stickers = await db.query(`SELECT ms.message_id AS "messageId",e.id,e.name,e.mime_type AS "mimeType",e.size_bytes AS "sizeBytes" FROM message_stickers ms JOIN expression_assets e ON e.id=ms.expression_id WHERE ms.message_id=ANY($1::text[])`, [ids])
  const stickerMap = new Map(stickers.rows.map(({ messageId, ...sticker }) => [messageId, sticker]))
  const botStickers = await db.query(`SELECT ms.message_id AS "messageId",s.id,s.name,s.mime_type AS "mimeType",s.size_bytes AS "sizeBytes",g.emotion,true AS "isBotSticker" FROM message_ai_stickers ms JOIN ai_agent_stickers s ON s.id=ms.sticker_id JOIN ai_agent_sticker_groups g ON g.id=s.group_id WHERE ms.message_id=ANY($1::text[])`, [ids])
  const botStickerMap = new Map(botStickers.rows.map(({ messageId, ...sticker }) => [messageId, sticker]))
  const reactions = await db.query(`SELECT message_id AS "messageId", emoji, count(*)::int AS count, bool_or(user_id=$2) AS reacted FROM reactions WHERE message_id=ANY($1::text[]) GROUP BY message_id, emoji ORDER BY emoji`, [ids, userId])
  const reactionMap = new Map()
  for (const reaction of reactions.rows) { const list = reactionMap.get(reaction.messageId) || []; list.push({ emoji: reaction.emoji, count: reaction.count, reacted: reaction.reacted }); reactionMap.set(reaction.messageId, list) }
  const replies = rows.filter((message) => message.replyTo?.id)
  const replyIds = [...new Set(replies.map((message) => message.replyTo.id))]
  const parents = replyIds.length ? await db.query('SELECT m.id, m.content, u.display_name AS author FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id=ANY($1::text[]) AND m.deleted_at IS NULL', [replyIds]) : { rows: [] }
  const parentMap = new Map(parents.rows.map((row) => [row.id, row]))
  rows.forEach((message) => {
    message.authorIsBot = botAuthorIds.has(message.authorId)
    message.attachments = attachmentMap.get(message.id) || []
    message.sticker = stickerMap.get(message.id) || null
    message.botSticker = botStickerMap.get(message.id) || null
    message.reactions = reactionMap.get(message.id) || []
    if (message.replyTo?.id && parentMap.has(message.replyTo.id)) message.replyTo = { ...message.replyTo, ...parentMap.get(message.replyTo.id) }
  })
  return rows
}

async function canReadChannel(channelId, userId) {
  const access = await db.query('SELECT 1 FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND m.user_id=$2 AND c.type=\'text\'', [channelId, userId])
  return access.rowCount > 0
}

app.get('/api/v1/channels/:channelId/messages', asyncRoute(async (req, res) => {
  const channelId = req.params.channelId
  if (!await canReadChannel(channelId, req.authUser.id)) return res.status(403).json({ error: '无权访问这个文字频道' })
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50))
  const beforeId = String(req.query.before || '')
  const afterId = String(req.query.after || '')
  const query = String(req.query.q || '').trim().slice(0, 200)
  const authorId = String(req.query.authorId || '')
  const fromDate = String(req.query.fromDate || '')
  const toDate = String(req.query.toDate || '')
  const hasImage = req.query.hasImage === 'true'
  const { rows } = await db.query(`SELECT m.id, m.channel_id AS "channelId", m.author_id AS "authorId", u.display_name AS author, u.avatar, u.color, m.content, m.mentions, m.reply_to AS "replyTo", m.pinned, m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt"
    FROM messages m JOIN users u ON u.id=m.author_id
    WHERE m.channel_id=$1
      AND (($4='' AND $5='' AND nullif($6,'') IS NULL AND nullif($7,'') IS NULL AND NOT $8::boolean) OR m.deleted_at IS NULL)
      AND ($2='' OR (m.created_at,m.id) < (SELECT created_at,id FROM messages WHERE id=$2 AND channel_id=$1))
      AND ($3='' OR (m.created_at,m.id) > (SELECT created_at,id FROM messages WHERE id=$3 AND channel_id=$1))
      AND ($4='' OR m.content ILIKE '%' || $4 || '%' OR u.display_name ILIKE '%' || $4 || '%')
      AND ($5='' OR m.author_id=$5)
      AND (nullif($6,'') IS NULL OR m.created_at >= nullif($6,'')::timestamptz)
      AND (nullif($7,'') IS NULL OR m.created_at < nullif($7,'')::timestamptz)
      AND (NOT $8::boolean OR EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%'))
    ORDER BY m.created_at ${afterId ? 'ASC' : 'DESC'},m.id ${afterId ? 'ASC' : 'DESC'} LIMIT $9`, [channelId, beforeId, afterId, query, authorId, fromDate, toDate, hasImage, limit + 1])
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  if (!afterId) rows.reverse()
  await hydrateMessages(rows, req.authUser.id)
  res.json({ messages: rows, hasMore, before: afterId ? null : rows[0]?.id || null, after: afterId ? rows.at(-1)?.id || null : null })
}))

app.get('/api/v1/servers/:serverId/messages/search', asyncRoute(async (req, res) => {
  const serverId = req.params.serverId
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权搜索这个小队' })
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50))
  const beforeId = String(req.query.before || '')
  const query = String(req.query.q || '').trim().slice(0, 200)
  const authorId = String(req.query.authorId || '')
  const fromDate = String(req.query.fromDate || '')
  const toDate = String(req.query.toDate || '')
  const hasImage = req.query.hasImage === 'true'
  if (!query && !authorId && !fromDate && !toDate && !hasImage) return res.json({ messages: [], hasMore: false, before: null })
  const { rows } = await db.query(`SELECT m.id,m.channel_id AS "channelId",c.name AS "channelName",m.author_id AS "authorId",u.display_name AS author,u.avatar,u.color,m.content,m.mentions,m.reply_to AS "replyTo",m.pinned,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt"
    FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.author_id
    WHERE c.server_id=$1 AND c.type='text' AND m.deleted_at IS NULL
      AND ($2='' OR (m.created_at,m.id)<(SELECT created_at,id FROM messages WHERE id=$2 AND channel_id IN(SELECT id FROM channels WHERE server_id=$1)))
      AND ($3='' OR m.content ILIKE '%' || $3 || '%' OR u.display_name ILIKE '%' || $3 || '%')
      AND ($4='' OR m.author_id=$4)
      AND (nullif($5,'') IS NULL OR m.created_at >= nullif($5,'')::timestamptz)
      AND (nullif($6,'') IS NULL OR m.created_at < nullif($6,'')::timestamptz)
      AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.mime_type LIKE 'image/%'))
    ORDER BY m.created_at DESC,m.id DESC LIMIT $8`, [serverId, beforeId, query, authorId, fromDate, toDate, hasImage, limit + 1])
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  rows.reverse()
  await hydrateMessages(rows, req.authUser.id)
  res.json({ messages: rows, hasMore, before: rows[0]?.id || null })
}))

app.get('/api/v1/channels/:channelId/pins', asyncRoute(async (req, res) => {
  if (!await canReadChannel(req.params.channelId, req.authUser.id)) return res.status(403).json({ error: '无权访问这个文字频道' })
  const { rows } = await db.query(`SELECT m.id,m.channel_id AS "channelId",m.author_id AS "authorId",u.display_name AS author,u.avatar,u.color,m.content,m.mentions,m.reply_to AS "replyTo",m.pinned,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt"
    FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND m.pinned ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, [req.params.channelId])
  await hydrateMessages(rows, req.authUser.id)
  res.json({ messages: rows.reverse() })
}))

app.get('/api/v1/messages/:messageId/context', asyncRoute(async (req, res) => {
  const target = await db.query(`SELECT m.id,m.channel_id AS "channelId",m.author_id AS "authorId",u.display_name AS author,u.avatar,u.color,m.content,m.mentions,m.reply_to AS "replyTo",m.pinned,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt"
    FROM messages m JOIN users u ON u.id=m.author_id JOIN channels c ON c.id=m.channel_id JOIN server_members sm ON sm.server_id=c.server_id
    WHERE m.id=$1 AND sm.user_id=$2 AND c.type='text'`, [req.params.messageId, req.authUser.id])
  if (!target.rows[0]) return res.status(404).json({ error: '找不到消息或无权访问' })
  const center = target.rows[0]
  const [older, newer] = await Promise.all([
    db.query(`SELECT m.id,m.channel_id AS "channelId",m.author_id AS "authorId",u.display_name AS author,u.avatar,u.color,m.content,m.mentions,m.reply_to AS "replyTo",m.pinned,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt" FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND (m.created_at,m.id)<($2,$3) ORDER BY m.created_at DESC,m.id DESC LIMIT 20`, [center.channelId, center.createdAt, center.id]),
    db.query(`SELECT m.id,m.channel_id AS "channelId",m.author_id AS "authorId",u.display_name AS author,u.avatar,u.color,m.content,m.mentions,m.reply_to AS "replyTo",m.pinned,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt" FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND (m.created_at,m.id)>($2,$3) ORDER BY m.created_at,m.id LIMIT 20`, [center.channelId, center.createdAt, center.id]),
  ])
  const messages = [...older.rows.reverse(), center, ...newer.rows]
  await hydrateMessages(messages, req.authUser.id)
  res.json({ messages, hasOlder: older.rows.length === 20, hasNewer: newer.rows.length === 20, channelId: center.channelId })
}))

app.put('/api/v1/channels/:channelId/read-state', asyncRoute(async (req, res) => {
  const channelId = req.params.channelId
  if (!await canReadChannel(channelId, req.authUser.id)) return res.status(403).json({ error: '无权访问这个文字频道' })
  const messageId = String(req.body.messageId || '')
  const result = await db.query(`INSERT INTO channel_read_states(user_id,channel_id,last_read_message_id,last_read_at,updated_at)
    SELECT $1,$2,m.id,m.created_at,now() FROM messages m WHERE m.id=$3 AND m.channel_id=$2
    ON CONFLICT(user_id,channel_id) DO UPDATE SET
      last_read_message_id=CASE WHEN channel_read_states.last_read_at IS NULL OR (excluded.last_read_at,excluded.last_read_message_id) > (channel_read_states.last_read_at,channel_read_states.last_read_message_id) THEN excluded.last_read_message_id ELSE channel_read_states.last_read_message_id END,
      last_read_at=CASE WHEN channel_read_states.last_read_at IS NULL OR (excluded.last_read_at,excluded.last_read_message_id) > (channel_read_states.last_read_at,channel_read_states.last_read_message_id) THEN excluded.last_read_at ELSE channel_read_states.last_read_at END,
      updated_at=now()
    RETURNING last_read_message_id AS "messageId"`, [req.authUser.id, channelId, messageId])
  if (!result.rowCount) return res.status(404).json({ error: '消息不存在或不属于这个频道' })
  res.json({ ok: true, messageId: result.rows[0].messageId })
}))

app.post('/api/v1/channels/:channelId/messages', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT c.server_id AS "serverId" FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND m.user_id=$2', [req.params.channelId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个频道' })
  const content = String(req.body.content || '').trim()
  if (content.length > 4000) return res.status(400).json({ error: '消息长度不能超过 4000 个字符' })
  const attachmentIds = [...new Set((Array.isArray(req.body.attachmentIds) ? req.body.attachmentIds : []).map((id) => String(id || '')).filter(Boolean))]
  const audioAttachmentId = String(req.body.audioAttachmentId || '')
  const stickerId = String(req.body.stickerId || '')
  if (!content && !attachmentIds.length && !audioAttachmentId && !stickerId) return res.status(400).json({ error: '消息内容、图片、语音或表情包不能为空' })
  if (attachmentIds.length > 10) return res.status(400).json({ error: '一条消息最多添加 10 张图片' })
  const requestedMentions = Array.isArray(req.body.mentions) ? req.body.mentions.slice(0, 50) : []
  const requestedIds = [...new Set(requestedMentions.map((item) => String(item?.userId || '')).filter(Boolean))]
  const mentionMembers = requestedIds.length ? await db.query(`SELECT u.id,u.display_name AS "displayName" FROM users u JOIN server_members sm ON sm.user_id=u.id WHERE sm.server_id=$1 AND u.id=ANY($2::text[])`, [access.rows[0].serverId, requestedIds]) : { rows: [] }
  const displayNames = new Map(mentionMembers.rows.map((member) => [member.id, member.displayName]))
  const mentions = []
  for (const mention of requestedMentions) {
    const userId = String(mention?.userId || ''); const displayName = displayNames.get(userId)
    const start = Number(mention?.start); const end = Number(mention?.end)
    if (!displayName || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length || content.slice(start, end) !== `@${displayName}`) continue
    if (mentions.some((item) => start < item.end && end > item.start)) continue
    mentions.push({ userId, start, end })
  }
  mentions.sort((a, b) => a.start - b.start)
  const id = `m-${randomUUID()}`
  const replyTo = req.body.replyTo?.id ? JSON.stringify({ id: req.body.replyTo.id }) : null
  const client = await db.connect()
  let messageRow; let attachedFiles = []; let sticker = null
  try {
    await client.query('BEGIN')
    if (attachmentIds.length) {
      const pending = await client.query(`SELECT id,message_id AS "messageId",file_name AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",duration_ms AS "durationMs" FROM message_attachments WHERE id=ANY($1::text[]) AND channel_id=$2 AND owner_user_id=$3 AND message_id IS NULL AND mime_type LIKE 'image/%' FOR UPDATE`, [attachmentIds, req.params.channelId, req.authUser.id])
      if (pending.rowCount !== attachmentIds.length) { const error = new Error('图片上传已失效，请重新选择图片'); error.status = 400; throw error }
      if (pending.rows.reduce((total, item) => total + Number(item.sizeBytes), 0) > MAX_MESSAGE_ATTACHMENT_BYTES) { const error = new Error('单条消息图片总大小不能超过 24 MB'); error.status = 400; throw error }
      attachedFiles = pending.rows
    }
    if (audioAttachmentId) {
      const pendingAudio = await client.query(`SELECT id,message_id AS "messageId",file_name AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",duration_ms AS "durationMs" FROM message_attachments WHERE id=$1 AND channel_id=$2 AND owner_user_id=$3 AND message_id IS NULL AND mime_type LIKE 'audio/%' FOR UPDATE`, [audioAttachmentId, req.params.channelId, req.authUser.id])
      if (!pendingAudio.rows[0]) { const error = new Error('录音上传已失效，请重新录制'); error.status = 400; throw error }
      if (Number(pendingAudio.rows[0].durationMs) > MAX_VOICE_MESSAGE_DURATION_MS) { const error = new Error('语音消息最长 2 分钟'); error.status = 400; throw error }
      attachedFiles.push(pendingAudio.rows[0])
    }
    if (attachedFiles.reduce((total, item) => total + Number(item.sizeBytes), 0) > MAX_MESSAGE_ATTACHMENT_BYTES) { const error = new Error('单条消息附件总大小不能超过 24 MB'); error.status = 400; throw error }
    if (stickerId) {
      const selected = await client.query(`SELECT id,name,mime_type AS "mimeType",size_bytes AS "sizeBytes" FROM expression_assets WHERE id=$1 AND server_id=$2 AND kind='sticker' AND deleted_at IS NULL AND (scope='system' OR owner_user_id=$3)`, [stickerId, access.rows[0].serverId, req.authUser.id])
      if (!selected.rowCount) { const error = new Error('这个表情包已不可用'); error.status = 400; throw error }
      sticker = selected.rows[0]
    }
    const result = await client.query(`INSERT INTO messages(id,channel_id,author_id,content,mentions,reply_to) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id, channel_id AS "channelId", author_id AS "authorId", content, mentions, reply_to AS "replyTo", pinned, created_at AS "createdAt"`, [id, req.params.channelId, req.authUser.id, content, JSON.stringify(mentions), replyTo])
    messageRow = result.rows[0]
    if (sticker) await client.query('INSERT INTO message_stickers(message_id,expression_id) VALUES($1,$2)', [id, sticker.id])
    const linkedAttachmentIds = [...attachmentIds, ...(audioAttachmentId ? [audioAttachmentId] : [])]
    if (linkedAttachmentIds.length) {
      const updated = await client.query('UPDATE message_attachments SET message_id=$1 WHERE id=ANY($2::text[]) AND owner_user_id=$3 AND message_id IS NULL RETURNING id', [id, linkedAttachmentIds, req.authUser.id])
      if (updated.rowCount !== linkedAttachmentIds.length) { const error = new Error('附件关联失败，请重试'); error.status = 409; throw error }
    }
    await client.query(`INSERT INTO channel_read_states(user_id,channel_id,last_read_message_id,last_read_at,updated_at)
      SELECT $1,$2,id,created_at,now() FROM messages WHERE id=$3
      ON CONFLICT(user_id,channel_id) DO UPDATE SET
        last_read_message_id=CASE WHEN channel_read_states.last_read_at IS NULL OR (excluded.last_read_at,excluded.last_read_message_id)>(channel_read_states.last_read_at,channel_read_states.last_read_message_id) THEN excluded.last_read_message_id ELSE channel_read_states.last_read_message_id END,
        last_read_at=CASE WHEN channel_read_states.last_read_at IS NULL OR (excluded.last_read_at,excluded.last_read_message_id)>(channel_read_states.last_read_at,channel_read_states.last_read_message_id) THEN excluded.last_read_at ELSE channel_read_states.last_read_at END,
        updated_at=now()`, [req.authUser.id, req.params.channelId, id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
  const message = { ...messageRow, author: req.authUser.displayName, avatar: req.authUser.avatar, color: req.authUser.color, attachments: attachedFiles, sticker, reactions: [] }
  await publish('message.created', message)
  setImmediate(() => maybeGenerateAiReply(db, req.params.channelId, message, publish).catch((error) => {
    log('error', 'ai_reply_dispatch_failed', { request_id: req.logRequestId, channel_id: req.params.channelId, ...errorFields(error) })
  }))
  res.status(201).json(message)
}))

app.post('/api/v1/channels/:channelId/attachments', express.raw({ type: 'image/*', limit: '8mb' }), asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND m.user_id=$2', [req.params.channelId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权在这个频道上传图片' })
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '没有收到图片数据' })
  const imageType = IMAGE_TYPES.get(req.get('Content-Type')?.split(';')[0].toLowerCase())
  if (!imageType || !imageType.matches(req.body)) return res.status(415).json({ error: '仅支持 PNG、JPEG、GIF 或 WebP 图片' })
  const pendingBytes = await db.query(`SELECT COALESCE(SUM(size_bytes),0)::bigint AS total FROM message_attachments WHERE owner_user_id=$1 AND channel_id=$2 AND message_id IS NULL`, [req.authUser.id, req.params.channelId])
  if (Number(pendingBytes.rows[0]?.total || 0) + req.body.length > MAX_MESSAGE_ATTACHMENT_BYTES) return res.status(413).json({ error: '待发送图片总大小不能超过 24 MB，请先移除部分图片' })
  let originalName = 'image'
  try { originalName = decodeURIComponent(req.get('X-File-Name') || 'image') } catch { /* Use the safe default for malformed names. */ }
  const fileName = basename(originalName.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'image'
  const storageKey = `${randomUUID()}${imageType.extension}`
  const id = `att-${randomUUID()}`
  await mkdir(uploadDir, { recursive: true })
  await writeFile(join(uploadDir, storageKey), req.body, { flag: 'wx' })
  try {
    const { rows } = await db.query(`INSERT INTO message_attachments(id,channel_id,owner_user_id,file_name,mime_type,size_bytes,storage_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,file_name AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes"`, [id, req.params.channelId, req.authUser.id, fileName, imageType.extension === '.jpg' ? 'image/jpeg' : req.get('Content-Type').split(';')[0].toLowerCase(), req.body.length, storageKey])
    res.status(201).json({ attachment: rows[0] })
  } catch (error) {
    await unlink(join(uploadDir, storageKey)).catch(() => {})
    throw error
  }
}))

app.post('/api/v1/channels/:channelId/audio', express.raw({ type: 'audio/*', limit: '8mb' }), asyncRoute(async (req, res) => {
  const access = await db.query("SELECT 1 FROM channels c JOIN server_members m ON m.server_id=c.server_id WHERE c.id=$1 AND c.type='text' AND m.user_id=$2", [req.params.channelId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权在这个频道发送语音' })
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '没有收到录音数据' })
  const mime = String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
  const audioType = AUDIO_TYPES.get(mime)
  if (!audioType || !audioType.matches(req.body)) return res.status(415).json({ error: '音频格式无效或当前格式不受支持' })
  const durationMs = Number(req.get('X-Audio-Duration-Ms'))
  if (!Number.isInteger(durationMs) || durationMs < 500 || durationMs > MAX_VOICE_MESSAGE_DURATION_MS) return res.status(400).json({ error: '语音时长需在 0.5 秒到 2 分钟之间' })
  const pendingBytes = await db.query(`SELECT COALESCE(SUM(size_bytes),0)::bigint AS total FROM message_attachments WHERE owner_user_id=$1 AND channel_id=$2 AND message_id IS NULL`, [req.authUser.id, req.params.channelId])
  if (Number(pendingBytes.rows[0]?.total || 0) + req.body.length > MAX_MESSAGE_ATTACHMENT_BYTES) return res.status(413).json({ error: '待发送附件总大小不能超过 24 MB' })
  const id = `att-${randomUUID()}`
  const storageKey = `${randomUUID()}${audioType.extension}`
  let originalName = 'voice-message'
  try { originalName = decodeURIComponent(req.get('X-File-Name') || originalName) } catch { /* Keep the safe default. */ }
  const fileName = basename(originalName.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'voice-message'
  await mkdir(uploadDir, { recursive: true })
  await writeFile(join(uploadDir, storageKey), req.body, { flag: 'wx' })
  try {
    const { rows } = await db.query(`INSERT INTO message_attachments(id,channel_id,owner_user_id,file_name,mime_type,size_bytes,storage_key,duration_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,file_name AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",duration_ms AS "durationMs"`, [id, req.params.channelId, req.authUser.id, fileName, mime, req.body.length, storageKey, durationMs])
    res.status(201).json({ attachment: rows[0] })
  } catch (error) { await unlink(join(uploadDir, storageKey)).catch(() => {}); throw error }
}))

app.get('/api/v1/servers/:serverId/expressions', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权访问这个小队的表情' })
  const [assets, groups] = await Promise.all([
    db.query(`SELECT id,kind,name,mime_type AS "mimeType",size_bytes AS "sizeBytes",owner_user_id AS "ownerUserId",group_id AS "groupId",is_builtin AS "isBuiltin",scope,created_at AS "createdAt" FROM expression_assets WHERE server_id=$1 AND deleted_at IS NULL AND (scope='system' OR owner_user_id=$2) ORDER BY scope,created_at,id`, [req.params.serverId, req.authUser.id]),
    db.query(`SELECT id,kind,name,source,builtin_key AS "builtinKey",scope,owner_user_id AS "ownerUserId",sort_order AS "sortOrder" FROM expression_groups WHERE server_id=$1 AND (scope='system' OR owner_user_id=$2) ORDER BY kind,scope,sort_order,name`, [req.params.serverId, req.authUser.id]),
  ])
  const rows = assets.rows
  const canManageSystem = Boolean((await db.query('SELECT 1 FROM ai_bot_admins WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])).rowCount)
  res.json({ emojis: rows.filter((item) => item.kind === 'emoji'), stickers: rows.filter((item) => item.kind === 'sticker'), groups: { emoji: groups.rows.filter((item) => item.kind === 'emoji'), sticker: groups.rows.filter((item) => item.kind === 'sticker') }, canUpload: true, canManageGroups: true, canManageSystem })
}))

app.post('/api/v1/servers/:serverId/expression-groups', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权管理这个小队的表情分组' })
  const kind = req.body.kind; const name = String(req.body.name || '').trim(); const scope = req.body.scope === 'system' ? 'system' : 'personal'
  if (!['emoji','sticker'].includes(kind) || !name || [...name].length > 32 || /[\u0000-\u001f]/.test(name)) return res.status(400).json({ error: '分组类型无效，名称需为 1–32 个字符' })
  if (scope === 'system' && !(await db.query('SELECT 1 FROM ai_bot_admins WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])).rowCount) return res.status(403).json({ error: '只有小队管理员可以管理系统表情' })
  try {
    const { rows } = await db.query(`INSERT INTO expression_groups(id,server_id,kind,name,source,scope,owner_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,name,source,builtin_key AS "builtinKey",scope,owner_user_id AS "ownerUserId",sort_order AS "sortOrder"`, [`expr-group-${randomUUID()}`, req.params.serverId, kind, name, scope === 'system' ? 'builtin' : 'user', scope, scope === 'personal' ? req.authUser.id : null, req.authUser.id])
    res.status(201).json({ group: rows[0] })
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: '这个分组名称已经存在' }); throw error }
}))

app.patch('/api/v1/expression-groups/:groupId', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name || [...name].length > 32 || /[\u0000-\u001f]/.test(name)) return res.status(400).json({ error: '分组名称需为 1–32 个字符' })
  const owned = await db.query(`SELECT g.id,g.server_id AS "serverId" FROM expression_groups g JOIN server_members sm ON sm.server_id=g.server_id AND sm.user_id=$2 WHERE g.id=$1 AND (g.owner_user_id=$2 OR (g.scope='system' AND EXISTS(SELECT 1 FROM ai_bot_admins a WHERE a.server_id=g.server_id AND a.user_id=$2)))`, [req.params.groupId, req.authUser.id])
  if (!owned.rows[0]) return res.status(404).json({ error: '找不到可管理的自建分组' })
  try {
    const { rows } = await db.query(`UPDATE expression_groups SET name=$2 WHERE id=$1 RETURNING id,kind,name,source,builtin_key AS "builtinKey",sort_order AS "sortOrder"`, [req.params.groupId, name])
    res.json({ group: rows[0] })
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: '这个分组名称已经存在' }); throw error }
}))

app.delete('/api/v1/expression-groups/:groupId', asyncRoute(async (req, res) => {
  const owned = await db.query(`SELECT g.id FROM expression_groups g JOIN server_members sm ON sm.server_id=g.server_id AND sm.user_id=$2 WHERE g.id=$1 AND (g.owner_user_id=$2 OR (g.scope='system' AND EXISTS(SELECT 1 FROM ai_bot_admins a WHERE a.server_id=g.server_id AND a.user_id=$2)))`, [req.params.groupId, req.authUser.id])
  if (!owned.rows[0]) return res.status(404).json({ error: '找不到可删除的自建分组' })
  await db.query('DELETE FROM expression_groups WHERE id=$1', [req.params.groupId])
  res.json({ ok: true })
}))

app.post('/api/v1/servers/:serverId/expressions', express.raw({ type: 'image/*', limit: '2mb' }), asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])
  if (!access.rowCount) return res.status(403).json({ error: '无权向这个小队上传表情' })
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '没有收到图片数据' })
  const kind = req.get('X-Expression-Kind')
  if (!['emoji','sticker'].includes(kind)) return res.status(400).json({ error: '表情类型无效' })
  const maxBytes = kind === 'emoji' ? 256 * 1024 : 2 * 1024 * 1024
  if (req.body.length > maxBytes) return res.status(413).json({ error: kind === 'emoji' ? '自定义 Emoji 最大 256 KB' : '表情包最大 2 MB' })
  const mime = req.get('Content-Type')?.split(';')[0].toLowerCase()
  const imageType = IMAGE_TYPES.get(mime)
  if (!imageType || !imageType.matches(req.body)) return res.status(415).json({ error: '仅支持 PNG、JPEG、GIF 或 WebP 图片' })
  let name = ''; try { name = decodeURIComponent(req.get('X-Expression-Name') || '') } catch { return res.status(400).json({ error: '名称编码无效' }) }
  name = name.trim()
  if (kind === 'emoji' ? !/^[a-zA-Z0-9_]{2,32}$/.test(name) : (!name || [...name].length > 40 || /[\u0000-\u001f]/.test(name))) return res.status(400).json({ error: kind === 'emoji' ? 'Emoji 名称需为 2–32 位英文字母、数字或下划线' : '表情包名称不能为空且最多 40 个字符' })
  const scope = req.get('X-Expression-Scope') === 'system' ? 'system' : 'personal'
  if (scope === 'system' && !(await db.query('SELECT 1 FROM ai_bot_admins WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.authUser.id])).rowCount) return res.status(403).json({ error: '只有小队管理员可以上传系统表情' })
  const count = scope === 'system'
    ? await db.query("SELECT count(*)::int AS count FROM expression_assets WHERE server_id=$1 AND scope='system' AND deleted_at IS NULL", [req.params.serverId])
    : await db.query("SELECT count(*)::int AS count FROM expression_assets WHERE server_id=$1 AND scope='personal' AND owner_user_id=$2 AND deleted_at IS NULL", [req.params.serverId, req.authUser.id])
  if (count.rows[0].count >= 200) return res.status(409).json({ error: scope === 'system' ? '系统表情库已达到 200 项上限' : '个人表情库已达到 200 项上限' })
  const storageKey = `expr-${randomUUID()}${imageType.extension}`; const id = `expr-${randomUUID()}`
  const groupId = req.get('X-Expression-Group') || null
  if (groupId) { const group = await db.query("SELECT 1 FROM expression_groups WHERE id=$1 AND server_id=$2 AND kind=$3 AND scope=$4 AND (scope='system' OR owner_user_id=$5)", [groupId, req.params.serverId, kind, scope, req.authUser.id]); if (!group.rowCount) return res.status(400).json({ error: '所选分组不存在、无权使用或类型不匹配' }) }
  await mkdir(uploadDir, { recursive: true }); await writeFile(join(uploadDir, storageKey), req.body, { flag: 'wx' })
  try {
    const { rows } = await db.query(`INSERT INTO expression_assets(id,server_id,owner_user_id,kind,name,mime_type,size_bytes,storage_key,group_id,scope,is_builtin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,kind,name,mime_type AS "mimeType",size_bytes AS "sizeBytes",owner_user_id AS "ownerUserId",group_id AS "groupId",is_builtin AS "isBuiltin",scope,created_at AS "createdAt"`, [id, req.params.serverId, scope === 'personal' ? req.authUser.id : null, kind, name, mime, req.body.length, storageKey, groupId, scope, scope === 'system'])
    try { await publish('expression.created', { serverId: req.params.serverId, expression: rows[0] }) }
    catch (error) { log('warn', 'expression_event_publish_failed', { request_id: req.logRequestId, server_id: req.params.serverId, ...errorFields(error) }) }
    res.status(201).json({ expression: rows[0] })
  } catch (error) { await unlink(join(uploadDir, storageKey)).catch(() => {}); if (error.code === '23505') return res.status(409).json({ error: '这个名称已经被使用' }); throw error }
}))

app.get('/api/v1/expressions/:expressionId', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`SELECT e.storage_key AS "storageKey",e.mime_type AS "mimeType",e.name,e.server_id AS "serverId" FROM expression_assets e JOIN server_members sm ON sm.server_id=e.server_id AND sm.user_id=$2 WHERE e.id=$1 AND ((e.deleted_at IS NULL AND (e.scope='system' OR e.owner_user_id=$2)) OR EXISTS(SELECT 1 FROM message_stickers ms JOIN messages m ON m.id=ms.message_id JOIN channels c ON c.id=m.channel_id WHERE ms.expression_id=e.id AND m.deleted_at IS NULL AND c.server_id=e.server_id))`, [req.params.expressionId, req.authUser.id])
  if (!rows[0]) return res.status(404).json({ error: '表情不存在或无权访问' })
  const data = await readFile(join(uploadDir, rows[0].storageKey)); res.setHeader('Content-Type', rows[0].mimeType); res.setHeader('Content-Disposition', 'inline'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=3600'); res.send(data)
}))

app.delete('/api/v1/expressions/:expressionId', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`UPDATE expression_assets e SET deleted_at=now() WHERE e.id=$1 AND e.deleted_at IS NULL AND (e.owner_user_id=$2 OR (e.scope='system' AND EXISTS(SELECT 1 FROM ai_bot_admins a WHERE a.server_id=e.server_id AND a.user_id=$2))) RETURNING e.id,e.kind,e.server_id AS "serverId"`, [req.params.expressionId, req.authUser.id])
  if (!rows[0]) return res.status(404).json({ error: '找不到可删除的表情，或你不是上传者' })
  try { await publish('expression.deleted', { serverId: rows[0].serverId, expressionId: rows[0].id }) }
  catch (error) { log('warn', 'expression_event_publish_failed', { request_id: req.logRequestId, expression_id: rows[0].id, ...errorFields(error) }) }
  res.json({ ok: true })
}))

app.get('/api/v1/attachments/:attachmentId', asyncRoute(async (req, res) => {
  const { rows } = await db.query(`SELECT a.storage_key AS "storageKey",a.mime_type AS "mimeType",a.file_name AS "fileName"
    FROM message_attachments a JOIN messages msg ON msg.id=a.message_id AND msg.deleted_at IS NULL JOIN channels c ON c.id=a.channel_id JOIN server_members m ON m.server_id=c.server_id
    WHERE a.id=$1 AND a.message_id IS NOT NULL AND m.user_id=$2`, [req.params.attachmentId, req.authUser.id])
  if (!rows[0]) return res.status(404).json({ error: '附件不存在或无权访问' })
  const data = await readFile(join(uploadDir, rows[0].storageKey))
  res.setHeader('Content-Type', rows[0].mimeType)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].fileName)}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.send(data)
}))

app.delete('/api/v1/attachments/:attachmentId', asyncRoute(async (req, res) => {
  const { rows } = await db.query('DELETE FROM message_attachments WHERE id=$1 AND owner_user_id=$2 AND message_id IS NULL RETURNING storage_key AS "storageKey"', [req.params.attachmentId, req.authUser.id])
  if (!rows[0]) return res.status(404).json({ error: '待发送附件不存在或已发送' })
  await unlink(join(uploadDir, rows[0].storageKey)).catch((error) => { if (error.code !== 'ENOENT') throw error })
  res.json({ ok: true })
}))

app.patch('/api/v1/messages/:messageId', asyncRoute(async (req, res) => {
  const content = String(req.body.content || '').trim()
  if (content.length > 4000) return res.status(400).json({ error: '消息长度不能超过 4000 个字符' })
  const target = await db.query(`SELECT m.id,m.channel_id AS "channelId",EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id) AS "hasAttachments"
    FROM messages m JOIN channels c ON c.id=m.channel_id JOIN server_members sm ON sm.server_id=c.server_id
    WHERE m.id=$1 AND m.author_id=$2 AND sm.user_id=$2 AND m.deleted_at IS NULL`, [req.params.messageId, req.authUser.id])
  if (!target.rows[0]) return res.status(404).json({ error: '找不到消息或无权编辑' })
  if (!content && !target.rows[0].hasAttachments) return res.status(400).json({ error: '消息内容不能为空' })
  const { rows } = await db.query(`UPDATE messages SET content=$2,mentions='[]'::jsonb,edited_at=now()
    WHERE id=$1 AND author_id=$3 AND deleted_at IS NULL
    RETURNING id,channel_id AS "channelId",author_id AS "authorId",content,mentions,reply_to AS "replyTo",pinned,created_at AS "createdAt",edited_at AS "editedAt",deleted_at AS "deletedAt"`, [req.params.messageId, content, req.authUser.id])
  const message = rows[0]
  if (!message) return res.status(404).json({ error: '消息已被删除或无法编辑' })
  const author = await db.query('SELECT display_name AS author,avatar,color FROM users WHERE id=$1', [req.authUser.id])
  Object.assign(message, author.rows[0])
  await hydrateMessages(rows, req.authUser.id)
  await publish('message.updated', { id: message.id, channelId: message.channelId })
  res.json(message)
}))

app.delete('/api/v1/messages/:messageId', asyncRoute(async (req, res) => {
  const client = await db.connect(); let channelId; let attachmentFiles = []
  try {
    await client.query('BEGIN')
    const updated = await client.query(`UPDATE messages msg SET content='',mentions='[]'::jsonb,deleted_at=now(),pinned=false
      FROM channels c JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
      WHERE msg.id=$1 AND msg.author_id=$2 AND msg.deleted_at IS NULL AND c.id=msg.channel_id RETURNING msg.channel_id AS "channelId"`, [req.params.messageId, req.authUser.id])
    if (!updated.rows[0]) { const error = new Error('找不到消息或无权删除'); error.status = 404; throw error }
    channelId = updated.rows[0].channelId
    const attachments = await client.query('DELETE FROM message_attachments WHERE message_id=$1 RETURNING storage_key AS "storageKey"', [req.params.messageId])
    attachmentFiles = attachments.rows
    await client.query('DELETE FROM reactions WHERE message_id=$1', [req.params.messageId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
  await Promise.all(attachmentFiles.map((item) => unlink(join(uploadDir, item.storageKey)).catch((error) => { if (error.code !== 'ENOENT') log('warn', 'deleted_message_attachment_cleanup_failed', { message_id: req.params.messageId, ...errorFields(error) }) })))
  await publish('message.updated', { id: req.params.messageId, channelId })
  res.json({ ok: true, id: req.params.messageId, channelId, deletedAt: new Date().toISOString() })
}))

app.put('/api/v1/messages/:messageId/reactions/:emoji', asyncRoute(async (req, res) => {
  const access = await db.query('SELECT 1 FROM messages msg JOIN channels c ON c.id=msg.channel_id JOIN server_members m ON m.server_id=c.server_id WHERE msg.id=$1 AND msg.deleted_at IS NULL AND m.user_id=$2', [req.params.messageId, req.authUser.id])
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
  const access = await db.query('SELECT 1 FROM messages msg JOIN channels c ON c.id=msg.channel_id JOIN server_members m ON m.server_id=c.server_id WHERE msg.id=$1 AND msg.deleted_at IS NULL AND m.user_id=$2', [req.params.messageId, req.authUser.id])
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

app.use((error, req, res, __) => {
  log('error', 'http_request_failed', {
    request_id: req.logRequestId,
    method: req.method,
    path: req.path,
    ...errorFields(error),
  })
  const status = error.status || (error.code === '23505' ? 409 : error.code === '23503' ? 404 : 500)
  res.status(status).json({ error: error.status ? error.message : error.code === '23505' ? '名称或语音关联已存在，请刷新后重试' : '服务器处理请求时发生错误' })
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
  await db.query(await readFile(new URL('./migrations/005_ai_agents.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/006_message_mentions.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/007_message_attachments.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/008_ai_image_read.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/009_ai_web_search.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/010_channel_read_state.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/011_message_edits.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/012_expressions.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/013_expression_groups.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/014_ai_agent_stickers.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/015_expression_scopes.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/016_voice_messages.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/017_ai_voice_replies.sql', import.meta.url), 'utf8'))
  await db.query(await readFile(new URL('./migrations/018_doubao_tts.sql', import.meta.url), 'utf8'))
  await mkdir(uploadDir, { recursive: true })
  await provisionTestAccounts()
  await redis.connect()
  await subscriber.connect()
  await subscriber.subscribe(EVENT_CHANNEL, (message) => {
    let event
    try { event = JSON.parse(message) } catch { return }
    const recipientUserId = event.recipientUserId
    delete event.recipientUserId
    const serialized = JSON.stringify(event)
    for (const socket of sockets) {
      if (socket.readyState !== 1 || !socket.userId) continue
      if (recipientUserId && socket.userId !== recipientUserId) continue
      socket.send(serialized)
    }
  })
  const cleanupPendingUploads = async () => {
    try {
      const { rows } = await db.query(`DELETE FROM message_attachments WHERE message_id IS NULL AND created_at < now() - interval '24 hours' RETURNING storage_key AS "storageKey"`)
      await Promise.all(rows.map((row) => unlink(join(uploadDir, row.storageKey)).catch(() => {})))
      if (rows.length) log('info', 'stale_uploads_cleaned', { count: rows.length })
    } catch (error) { log('warn', 'stale_upload_cleanup_failed', errorFields(error)) }
  }
  await cleanupPendingUploads()
  setInterval(cleanupPendingUploads, 60 * 60 * 1000).unref()
  server.listen(PORT, '0.0.0.0', () => log('info', 'api_listening', { port: PORT }))
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  log('info', 'api_shutdown_started', { signal })
  server.close()
  await subscriber.quit()
  await redis.quit()
  await db.end()
  process.exit(0)
})
start().catch((error) => { log('fatal', 'api_start_failed', errorFields(error)); process.exit(1) })
