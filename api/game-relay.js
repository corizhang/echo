import { WebSocketServer } from 'ws'
import { randomBytes, createHash } from 'node:crypto'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// Single API instance, two-player experimental relay. No client-supplied targets.
export function createGameRelay(db) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  const tickets = new Map(), rooms = new Map()
  const hash = value => createHash('sha256').update(value).digest('hex')
  const send = (ws, data, binary = false) => {
    if (!ws || ws.readyState !== 1) return
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Relay congested'); return }
    ws.send(data, { binary })
  }
  const json = (ws, data) => send(ws, JSON.stringify(data))
  const member = async (roomId, memberId) => (await db.query(`SELECT m.role FROM game_room_members m JOIN game_rooms r ON r.id=m.room_id WHERE m.room_id=$1 AND m.id=$2 AND m.status<>'left' AND r.status<>'closed' AND r.game_version='1.24e'`, [roomId, memberId])).rows[0]
  function issue(m) {
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key)
    if (tickets.size > 1024) throw new Error('Relay ticket limit')
    const ticket = randomBytes(32).toString('base64url')
    tickets.set(hash(ticket), { roomId: m.roomId, memberId: m.id, expires: Date.now() + 30000 })
    return ticket
  }
  async function reconcile(roomId) {
    const room = rooms.get(roomId); if (!room) return
    for (const ws of [...room.peers.values()]) {
      let current
      try { current = await member(roomId, ws.memberId) }
      catch (error) {
        console.error('Relay membership check failed; retaining active peer for retry', { roomId, memberId: ws.memberId, error: error.message })
        continue
      }
      if (!current || (current.role === 'host') !== ws.isHost) ws.close(1008, 'Room membership changed')
    }
  }
  function publishNetwork(room) {
    const peers = [...room.peers.values()].map(peer => ({
      role: peer.isHost ? 'host' : 'guest',
      rttMs: peer.rttMs ?? null,
      jitterMs: peer.jitterMs ?? null,
      missedPongs: peer.missedPongs || 0,
      rttHistory: peer.rttHistory || [],
    }))
    for (const peer of room.peers.values()) json(peer, { type: 'network', peers })
  }
  function percentile(values, fraction) {
    if (!values.length) return null
    return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]
  }
  const diagnosticsTimer = setInterval(() => {
    const eventLoop = {
      p95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(1)),
      maxMs: Number((eventLoopDelay.max / 1e6).toFixed(1)),
    }
    eventLoopDelay.reset()
    const now = performance.now()
    for (const ws of wss.clients) {
      if (!ws.roomId) continue
      const windowStart = Date.now() - 5 * 60 * 1000
      const samples = (ws.rttHistory || []).filter(sample => sample.at >= windowStart).map(sample => sample.rttMs).sort((a, b) => a - b)
      const missedPongs = ws.missedPongs || 0
      console.info('Relay network diagnostic window', {
        windowSeconds: 300,
        roomId: ws.roomId,
        memberId: ws.memberId,
        role: ws.isHost ? 'host' : 'guest',
        sampleCount: samples.length,
        rttMs: samples.length ? {
          min: samples[0],
          median: percentile(samples, 0.5),
          p95: samples.length >= 40 ? percentile(samples, 0.95) : null,
          max: samples[samples.length - 1],
        } : null,
        p95Status: samples.length >= 40 ? 'ready' : 'collecting-at-least-40-samples',
        rttSamples: samples.length,
        recentRttSamples: (ws.rttHistory || []).filter(sample => sample.at >= windowStart).slice(-12),
        jitterMs: ws.jitterMs ?? null,
        lastPongAgeMs: ws.lastPongAt === undefined ? null : Math.round(now - ws.lastPongAt),
        missedPongsWindow: missedPongs - (ws.lastReportedMissedPongs || 0),
        missedPongsTotal: missedPongs,
        bufferedAmount: ws.bufferedAmount,
        eventLoop,
      })
      ws.lastReportedMissedPongs = missedPongs
    }
  }, 30000)
  diagnosticsTimer.unref()
  wss.on('connection', ws => {
    ws.pendingPings = new Map()
    ws.rttHistory = []
    ws.missedPongs = 0
    ws.consecutiveMissedPongs = 0
    ws.on('pong', data => {
      const key = Buffer.from(data).toString('hex')
      const sentAt = ws.pendingPings.get(key)
      if (sentAt === undefined) return
      ws.pendingPings.delete(key)
      const rtt = Math.max(0, Math.round(performance.now() - sentAt))
      if (ws.rttMs !== undefined) {
        const difference = Math.abs(rtt - ws.rttMs)
        ws.jitterMs = ws.jitterMs === undefined ? difference : Math.round(ws.jitterMs * 0.875 + difference * 0.125)
      } else ws.jitterMs = 0
      ws.rttMs = rtt
      ws.lastPongAt = performance.now()
      const at = Date.now()
      ws.rttHistory.push({ at, rttMs: rtt, pingId: key })
      ws.rttHistory = ws.rttHistory.filter(sample => at - sample.at <= 5 * 60 * 1000).slice(-60)
      ws.consecutiveMissedPongs = 0
      const room = rooms.get(ws.roomId)
      if (room) publishNetwork(room)
    })
    const authTimeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000)
    let authenticating = false, joined = false, windowStart = Date.now(), bytes = 0, frames = 0
    ws.on('message', async (data, binary) => {
      try {
        if (!joined) {
          if (authenticating || binary || data.length > 256) return ws.close(1008, 'Invalid authentication')
          authenticating = true
          const input = JSON.parse(data.toString()); const key = hash(String(input.ticket || ''))
          const ticket = tickets.get(key); tickets.delete(key)
          if (!ticket || ticket.expires < Date.now()) return ws.close(1008, 'Ticket expired')
          const current = await member(ticket.roomId, ticket.memberId)
          if (!current || ws.readyState !== 1) return ws.close(1008, 'Room access denied')
          let room = rooms.get(ticket.roomId)
          if (!room) { room = { peers: new Map(), stream: 0 }; rooms.set(ticket.roomId, room) }
          const isHost = current.role === 'host'
          if (room.peers.has(ticket.memberId) || [...room.peers.values()].some(p => p.isHost === isHost)) return ws.close(1008, 'Experimental relay supports one host and one guest')
          Object.assign(ws, { roomId: ticket.roomId, memberId: ticket.memberId, isHost })
          room.peers.set(ws.memberId, ws); joined = true; clearTimeout(authTimeout)
          json(ws, { type: 'ready', role: isHost ? 'host' : 'guest' })
          for (const peer of room.peers.values()) json(peer, { type: 'peers', count: room.peers.size })
          publishNetwork(room)
          return
        }
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); bytes = 0; frames = 0 }
        bytes += data.length; frames++
        if (bytes > 2*1024*1024 || frames > 512) return ws.close(1008, 'Relay rate limit')
        const room = rooms.get(ws.roomId); if (!room) return ws.close()
        const other = [...room.peers.values()].find(p => p !== ws)
        if (!binary) {
          if (!ws.isHost || data.length > 12000) return ws.close(1008, 'Invalid advertisement')
          const m = JSON.parse(data.toString())
          if (m.type !== 'advertisement' || !Array.isArray(m.packet) || m.packet.length < 44 || m.packet.length > 2048 || m.packet.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return ws.close(1008, 'Invalid game packet')
          const p = Buffer.from(m.packet)
          if (p[0] !== 247 || p[1] !== 48 || p.readUInt16LE(2) !== p.length || p.readUInt32LE(8) !== 24) return ws.close(1008, 'Only Warcraft 1.24 discovery supported')
          json(other, { type: 'advertisement', packet: m.packet }); return
        }
        if (data.length < 5 || data.length > 32773) return ws.close(1008, 'Invalid frame')
        const kind = data[0], id = data.readUInt32LE(1)
        if (!id || ![1,2,3].includes(kind) || (kind !== 2 && data.length !== 5)) return ws.close(1008, 'Invalid stream')
        if (kind === 1) {
          if (ws.isHost || room.stream) return ws.close(1008, 'Only one game connection supported')
          if (!other) { const close = Buffer.from(data); close[0] = 3; send(ws, close, true); return }
          room.stream = id
        } else if (room.stream !== id) return // Ignore an already closed stream.
        if (kind === 3) room.stream = 0
        send(other, data, true)
      } catch (error) {
        console.error('Relay request rejected', { roomId: ws.roomId, memberId: ws.memberId, error: error.message })
        ws.close(1008, 'Invalid relay request')
      }
    })
    ws.on('error', error => console.warn('Relay WebSocket error', { roomId: ws.roomId, memberId: ws.memberId, error: error.message }))
    ws.on('close', (code, reason) => {
      clearTimeout(authTimeout)
      console.warn('Relay peer disconnected', { roomId: ws.roomId, memberId: ws.memberId, role: ws.isHost ? 'host' : 'guest', code, reason: reason.toString(), rttMs: ws.rttMs ?? null, missedPongs: ws.missedPongs || 0 })
      if (!joined) return
      const room = rooms.get(ws.roomId); if (!room) return
      room.peers.delete(ws.memberId); room.stream = 0
      // Existing matches cannot migrate or resume after either endpoint disconnects.
      for (const peer of room.peers.values()) peer.close(1012, 'Peer disconnected; reconnect relay')
      if (!room.peers.size) rooms.delete(ws.roomId)
    })
  })
  const timer = setInterval(async () => {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue
      // `sentAt` is recorded with performance.now(); keep expiry on the same
      // monotonic clock so wall-clock epoch time cannot expire every ping.
      const now = performance.now()
      for (const [key, sentAt] of ws.pendingPings) {
        if (now - sentAt < 15000) continue
        ws.pendingPings.delete(key)
        ws.missedPongs++
        ws.consecutiveMissedPongs++
      }
      if (ws.consecutiveMissedPongs >= 3) {
        console.warn('Relay peer missed three heartbeat windows', { roomId: ws.roomId, memberId: ws.memberId, missedPongs: ws.missedPongs })
        ws.terminate()
        continue
      }
      const payload = randomBytes(8)
      const key = payload.toString('hex')
      ws.pendingPings.set(key, performance.now())
      if (ws.pendingPings.size > 8) ws.pendingPings.delete(ws.pendingPings.keys().next().value)
      ws.ping(payload, false, error => { if (error) console.warn('Relay heartbeat send failed', { roomId: ws.roomId, memberId: ws.memberId, error: error.message }) })
    }
    for (const id of rooms.keys()) {
      try { await reconcile(id) }
      catch (error) { console.error('Relay membership reconciliation failed; keeping active peers', { roomId: id, error: error.message }) }
    }
  }, 5000)
  timer.unref()
  return { issue, reconcile, upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)) }
}
