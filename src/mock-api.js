(() => {
  const FIXTURES = window.EchoFixtures
  const STORAGE_KEY = 'echo.mock.v1'
  const ROOM_STORAGE_KEY = 'echo.game-room.v1'
  const listeners = new Map()
  const clone = (value) => JSON.parse(JSON.stringify(value))
  let state = clone(FIXTURES)
  try { state.gameRooms = JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}').rooms || {} } catch { state.gameRooms = {} }
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const previous = JSON.parse(saved)
      state.messages = { ...state.messages, ...previous.messages }
      if (Array.isArray(previous.channels)) state.channels.push(...previous.channels.filter((channel) => !state.channels.some((item) => item.id === channel.id)))
    }
  } catch { /* Browser storage can be unavailable in private modes. */ }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: state.messages, channels: state.channels.filter((channel) => channel.id.startsWith('channel-')) })) } catch { /* In-memory mock remains usable. */ }
  }
  function roomState() { try { return JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}') } catch { return {} } }
  function saveRoomState(next) { try { localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(next)) } catch { /* In-memory mock remains usable. */ } }
  function emit(type, payload) {
    for (const listener of listeners.get(type) || []) listener(clone(payload))
  }

  window.EchoApi = {
    mode: 'mock',
    async getMe() { return clone(state.currentUser) },
    async getServers() { return clone(state.servers) },
    async getChannels(serverId) { return clone(state.channels.filter((item) => item.serverId === serverId)) },
    async getMessages(channelId) { return clone(state.messages[channelId] || []) },
    async getMembers(serverId) { return clone(state.members.filter((member) => serverId === 'server-squad' || member.id !== 'user-kira')) },
    async createChannel(serverId, input) {
      const name = String(input.name || '').trim().replace(/\s+/g, '-')
      if (!name) throw new Error('频道名称不能为空')
      if (state.channels.some((channel) => channel.serverId === serverId && channel.name === name)) throw new Error('这个频道已经存在')
      const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const channel = { id: `channel-${randomId}`, serverId, name, type: input.type === 'voice' ? 'voice' : 'text', topic: input.topic || '新建频道' }
      state.channels.push(channel); emit('channel.created', channel); return clone(channel)
    },
    async sendMessage(channelId, input) {
      const content = String(input.content || '').trim()
      if (!content) throw new Error('消息不能为空')
      const message = { id: `m-${crypto.randomUUID()}`, channelId, authorId: state.currentUser.id, author: state.currentUser.displayName, avatar: state.currentUser.avatar, color: 'blue', createdAt: new Date().toISOString(), content, replyTo: input.replyTo || null, pinned: false, reactions: [] }
      state.messages[channelId] ||= []
      state.messages[channelId].push(message)
      persist()
      emit('message.created', message)
      return clone(message)
    },
    async toggleReaction(messageId, emoji) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message) throw new Error('找不到消息')
      const reaction = message.reactions.find((item) => item.emoji === emoji)
      if (reaction) { reaction.count += reaction.reacted ? -1 : 1; reaction.reacted = !reaction.reacted; if (reaction.count <= 0) message.reactions = message.reactions.filter((item) => item !== reaction) }
      else message.reactions.push({ emoji, count: 1, reacted: true })
      persist(); emit('message.updated', message); return clone(message)
    },
    async togglePin(messageId) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message) throw new Error('找不到消息')
      message.pinned = !message.pinned; persist(); emit('message.updated', message); return clone(message)
    },
    async getVoiceToken(channelId) {
      const channel = state.channels.find((item) => item.id === channelId && item.type === 'voice')
      if (!channel) throw new Error('语音频道不存在')
      return { url: 'wss://voice.example.invalid', token: 'mock-token-not-for-production', room: channel.id, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
    },
    async setVoicePresence(channelId, connected) {
      const presence = { userId: state.currentUser.id, channelId, connected, updatedAt: new Date().toISOString() }
      emit('voice.presence', presence); return clone(presence)
    },
    async listGameRooms(serverId) { return clone(Object.values(roomState().rooms || {}).filter(room => room.serverId === serverId && room.status !== 'closed')) },
    async previewGameRoom(roomId) { const room = roomState().rooms?.[roomId]; if (!room || room.status === 'closed') throw new Error('房间已结束或不存在'); return clone(room) },
    hasGameSession(roomId) { return Boolean(roomState().sessions?.[roomId]) },
    forgetGameSession(roomId) { const next = roomState(); delete next.sessions?.[roomId]; delete next.invites?.[roomId]; if (next.activeRoomId === roomId) next.activeRoomId = null; saveRoomState(next) },
    getActiveGameRoomId() { return roomState().activeRoomId || null },
    async createGameRoom(serverId, input) {
      const next = roomState(); const id = `game-${crypto.randomUUID()}`; const memberId = `player-${crypto.randomUUID()}`
      const room = { id, serverId, title: input.title, gameVersion: '1.24e', mapName: input.mapName || '', status: 'waiting', voiceRoomId: input.voiceChannelId || id, hostMemberId: memberId, createdAt: new Date().toISOString(), inviteExpiresAt: new Date(Date.now()+604800000).toISOString(), members: [{ id: memberId, displayName: input.displayName, role: 'host', status: 'joined' }] }
      next.rooms ||= {}; next.rooms[id] = room; next.sessions ||= {}; next.sessions[id] = crypto.randomUUID(); next.members ||= {}; next.members[id] = memberId; next.invites ||= {}; next.invites[id] = crypto.randomUUID(); next.activeRoomId = id
      next.messages ||= {}; next.messages[id] = [{ id: crypto.randomUUID(), kind: 'system', author: input.displayName, content: `${input.displayName} 创建了房间`, createdAt: new Date().toISOString() }]
      saveRoomState(next); emit('game-room.updated', { roomId: id }); return this.getGameRoom(id)
    },
    async joinGameRoom(roomId, inviteCode, displayName) {
      if (this.hasGameSession(roomId)) return this.getGameRoom(roomId)
      const next = roomState(); const room = next.rooms?.[roomId]; if (!room || room.status === 'closed') throw new Error('房间已结束或不存在')
      if (room.members.filter(member => member.status !== 'left').length >= 8) throw new Error('游戏房间最多容纳 8 人')
      const memberId = `player-${crypto.randomUUID()}`; room.members.push({ id: memberId, displayName, role: 'player', status: 'joined' }); next.sessions ||= {}; next.sessions[roomId] = crypto.randomUUID(); next.members ||= {}; next.members[roomId] = memberId; next.activeRoomId = roomId
      saveRoomState(next); emit('game-room.updated', { roomId }); return this.getGameRoom(roomId)
    },
    async getGameRoom(roomId) { const next = roomState(); const room = next.rooms?.[roomId]; const self = room?.members.find(m => m.id === next.members?.[roomId] && m.status !== 'left'); if (!self || room.status === 'closed' || !next.sessions?.[roomId]) { const error = new Error('房间会话已结束'); error.status = 403; throw error } return { ...clone(room), members: clone(room.members.filter(m => m.status !== 'left')), currentMemberId: self.id, role: self.role } },
    getGameInviteCode(roomId) { return roomState().invites?.[roomId] || null },
    async createGameInvite(roomId) { const room = await this.getGameRoom(roomId); if (room.role !== 'host') throw new Error('只有房主可以邀请'); const next = roomState(); next.invites ||= {}; next.invites[roomId] = crypto.randomUUID(); saveRoomState(next); return next.invites[roomId] },
    async getGameMessages(roomId) { await this.getGameRoom(roomId); return clone(roomState().messages?.[roomId] || []) },
    async sendGameMessage(roomId, content) { const room = await this.getGameRoom(roomId); const next = roomState(); next.messages ||= {}; next.messages[roomId] ||= []; next.messages[roomId].push({ id: crypto.randomUUID(), memberId: room.currentMemberId, author: room.members.find(m => m.id === room.currentMemberId).displayName, content, kind: 'message', createdAt: new Date().toISOString() }); saveRoomState(next); emit('game-room.message', { roomId }); return { ok: true } },
    async setGameMemberStatus(roomId, memberStatus, roomStatus) { const room = await this.getGameRoom(roomId); if (!['joined','ready','starting','running'].includes(memberStatus)) throw new Error('无效的玩家状态'); if (roomStatus && (room.role !== 'host' || !['waiting','in_game','closed'].includes(roomStatus))) throw new Error('无效的房间状态或权限'); const next = roomState(); next.rooms[roomId].members.find(m => m.id === room.currentMemberId).status = memberStatus; if (roomStatus) next.rooms[roomId].status = roomStatus; saveRoomState(next); emit('game-room.updated', { roomId }); return { ...room, members: clone(next.rooms[roomId].members.filter(m => m.status !== 'left')), status: roomStatus || room.status } },
    async leaveGameRoom(roomId, endRoom = false) { const room = await this.getGameRoom(roomId); if (endRoom && room.role !== 'host') throw new Error('只有房主可以结束房间'); const next = roomState(); const saved = next.rooms[roomId]; const self = saved.members.find(m => m.id === room.currentMemberId); const others = saved.members.filter(m => m.id !== self.id && m.status !== 'left'); if (endRoom || !others.length) saved.status = 'closed'; else if (self.role === 'host') { others[0].role = 'host'; saved.hostMemberId = others[0].id } self.status = 'left'; self.role = 'player'; saveRoomState(next); this.forgetGameSession(roomId); emit('game-room.updated', { roomId }); return { ok: true } },
    async getGameVoiceToken(roomId) { const room = await this.getGameRoom(roomId); return { url: '', token: 'mock', room: room.voiceRoomId } },
    subscribe(type, listener) {
      listeners.set(type, listeners.get(type) || new Set()); listeners.get(type).add(listener)
      return () => listeners.get(type)?.delete(listener)
    },
  }
})()
