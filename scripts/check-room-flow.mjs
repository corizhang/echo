import assert from 'node:assert/strict'

// Exercises the running local API with isolated rooms; closes only rooms it creates.
const base = 'http://localhost:8080/api/v1'
async function call(path, method = 'GET', body, token, expected = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Echo-Game-Session': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await res.json()
  assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`)
  return value
}
let room, ownerToken
try {
  const created = await call('/servers/server-squad/game-rooms', 'POST', { title: '房间流程检查（临时）', displayName: '检查房主', mapName: '1.24e', }, undefined, 201)
  room = created.room.id; ownerToken = created.sessionToken
  assert((await call('/servers/server-squad/game-rooms')).some(item => item.id === room))
  const preview = await call(`/game-rooms/${room}/preview`, 'POST', {})
  assert.equal(preview.members.length, 1)
  await call(`/game-rooms/${room}/messages`, 'GET', undefined, undefined, 403)
  const player = await call(`/game-rooms/${room}/join`, 'POST', { displayName: '检查好友' }, undefined, 201)
  const retry = await call(`/game-rooms/${room}/join`, 'POST', { displayName: '检查好友' }, player.sessionToken)
  assert.equal(retry.memberId, player.memberId)
  assert.equal(retry.room.members.length, 2)
  await call(`/game-rooms/${room}/leave`, 'POST', { endRoom: true }, player.sessionToken, 403)
  const content = '<img src=x onerror=alert(1)> 纯文本消息'
  await call(`/game-rooms/${room}/messages`, 'POST', { content }, player.sessionToken, 201)
  assert((await call(`/game-rooms/${room}/messages`, 'GET', undefined, ownerToken)).some(message => message.content === content))
  const voice = await call(`/game-rooms/${room}/voice-token`, 'POST', {}, player.sessionToken)
  assert.equal(voice.room, room)
  assert.equal(voice.url, 'ws://localhost:8080')
  await call(`/game-rooms/${room}/leave`, 'POST', {}, ownerToken)
  ownerToken = player.sessionToken
  const transferred = await call(`/game-rooms/${room}`, 'GET', undefined, ownerToken)
  assert.equal(transferred.role, 'host')
  assert.equal(transferred.room.hostMemberId, player.memberId)
  const invitation = await call(`/game-rooms/${room}/invite`, 'POST', {}, ownerToken)
  assert(invitation.inviteCode.length > 24)
  await call(`/game-rooms/${room}/leave`, 'POST', { endRoom: true }, ownerToken)
  assert(!(await call('/servers/server-squad/game-rooms')).some(item => item.id === room))
  await call(`/game-rooms/${room}/voice-token`, 'POST', {}, ownerToken, 403)
  ownerToken = null
  console.log('PASS: room discovery, preview, membership, message access, voice token, host transfer, invitation and closure')
} finally {
  if (room && ownerToken) await call(`/game-rooms/${room}/leave`, 'POST', { endRoom: true }, ownerToken).catch(error => console.error('Cleanup:', error.message))
}

let shared
try {
  shared = await call('/servers/server-squad/game-rooms', 'POST', { title: '语音大厅关联检查（临时）', displayName: '检查房主', voiceChannelId: 'voice-lobby' }, undefined, 201)
  const ticket = await call(`/game-rooms/${shared.room.id}/voice-token`, 'POST', {}, shared.sessionToken)
  assert.equal(ticket.room, 'voice-lobby')
  assert.equal(ticket.url, 'ws://localhost:8080')
  await call('/servers/server-squad/game-rooms', 'POST', { title: '重复关联检查', displayName: '检查房主', voiceChannelId: 'voice-lobby' }, undefined, 409)
  console.log('PASS: inherited voice room, single active activity per lobby and proxy port preservation')
} finally {
  if (shared) await call(`/game-rooms/${shared.room.id}/leave`, 'POST', { endRoom: true }, shared.sessionToken)
}
