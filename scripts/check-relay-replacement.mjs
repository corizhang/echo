import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { createGameRelay } from '../api/game-relay.js'
const require = createRequire(new URL('../api/package.json', import.meta.url))
const { WebSocket } = require('ws')
const db = { query: async (_sql, [, memberId]) => ({ rows: [{ role: memberId === 'host' ? 'host' : 'player' }] }) }
const relay = createGameRelay(db), server = createServer(), clients = []
server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket, head))
server.listen(0, '127.0.0.1'); await once(server, 'listening')
function next(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('message timeout')) }, 3000)
    function listener(data, binary) { const value = binary ? data : JSON.parse(data); if (predicate(value, binary)) { clearTimeout(timer); ws.off('message', listener); resolve(value) } }
    ws.on('message', listener)
  })
}
async function connect(memberId) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`); clients.push(ws)
  await once(ws, 'open')
  const ready = next(ws, (msg, binary) => !binary && msg.type === 'ready')
  ws.send(JSON.stringify({ ticket: relay.issue({ roomId: 'test-room', id: memberId }) }))
  await ready; return ws
}
try {
  const host = await connect('host'), guest = await connect('guest')
  const oldClosed = once(guest, 'close')
  const replacement = await connect('guest'); await oldClosed
  assert.equal(host.readyState, WebSocket.OPEN, 'guest replacement must not disconnect host')
  const newHost = await connect('host')
  assert.equal(replacement.readyState, WebSocket.OPEN, 'idle host replacement must not disconnect guests')
  // An active guest stream must remain protected from replacement.
  const assignment = next(replacement, (msg, binary) => binary && msg[0] === 4)
  const open = Buffer.alloc(5); open[0] = 1; open.writeUInt32LE(1, 1); replacement.send(open)
  await assignment
  const denied = new WebSocket(`ws://127.0.0.1:${server.address().port}/`); clients.push(denied); await once(denied, 'open')
  const closed = once(denied, 'close')
  denied.send(JSON.stringify({ ticket: relay.issue({ roomId: 'test-room', id: 'guest' }) }))
  const [code] = await closed; assert.equal(code, 1008)
  assert.equal(replacement.readyState, WebSocket.OPEN)
  assert.equal(newHost.readyState, WebSocket.OPEN)
  console.log('Idle relay replacement and active-stream protection passed')
} finally {
  for (const ws of clients) ws.terminate()
  await new Promise(resolve => server.close(resolve))
}

