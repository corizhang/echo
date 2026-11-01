(() => {
  if (location.protocol === 'file:') return
  const base = window.EchoDesktop ? window.EchoServerUrl : location.origin
  const listeners = new Map()
  const AUTH_TOKEN_KEY = 'echo.auth.v1'
  const getToken = () => localStorage.getItem(AUTH_TOKEN_KEY) || ''
  const ROOM_STORAGE_KEY = 'echo.game-room.v1'
  const readRoomState = () => { try { return JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}') } catch { return {} } }
  const writeRoomState = (state) => localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(state))
  const localDateBoundary = (value, addDay = false) => { if (!value) return ''; const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day + (addDay ? 1 : 0)).toISOString() }
  const request = async (path, options = {}) => {
    const roomId = path.match(/^\/game-rooms\/([^/]+)/)?.[1]
    const roomState = readRoomState()
    const roomToken = roomId && roomState.sessions?.[decodeURIComponent(roomId)]
    const token = getToken()
    const response = await fetch(`${base}/api/v1${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(roomToken ? { 'X-Echo-Game-Session': roomToken } : {}), ...options.headers } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) { const error = new Error(body.error || `请求失败 (${response.status})`); error.status = response.status; if (response.status === 401 && !path.startsWith('/auth/login')) emit({ type: 'auth.expired', data: {} }); throw error }
    return body
  }
  const emit = (event) => { for (const listener of listeners.get(event.type) || []) listener(event.data) }
  let socket, retryTimer, stopped = false
  function connectEvents() {
    if (stopped || !getToken()) return
    socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/events`)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: getToken() }))
    socket.onmessage = ({ data }) => { try { const event = JSON.parse(data); if (event.type === 'authenticated') emit({ type: 'connection.restored', data: {} }); else emit(event) } catch (error) { console.warn('Invalid event', error) } }
    socket.onclose = () => { if (!stopped) retryTimer = setTimeout(connectEvents, 2500) }
  }
  connectEvents()

  window.EchoApi = {
    mode: 'http',
    currentToken: getToken,
    async login(username, password) { const result = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); localStorage.setItem(AUTH_TOKEN_KEY, result.token); socket?.close(); connectEvents(); return result.user },
    async logout() { try { await request('/auth/logout', { method: 'POST' }) } finally { localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem('echo.game-room.v1'); window.dispatchEvent(new CustomEvent('echo:signed-out')); socket?.close() } },
    getGameRelayTicket: (id) => request(`/game-rooms/${encodeURIComponent(id)}/relay-ticket`, { method: 'POST' }),
    getMe: () => request('/me'),
    getServers: () => request('/servers'),
    getChannels: (serverId) => request(`/servers/${encodeURIComponent(serverId)}/channels`),
    getMembers: (serverId) => request(`/servers/${encodeURIComponent(serverId)}/members`),
    getExpressions: (serverId) => request(`/servers/${encodeURIComponent(serverId)}/expressions`),
    async uploadExpression(serverId, kind, file, name, groupId = '', scope = 'personal') {
      const response = await fetch(`${base}/api/v1/servers/${encodeURIComponent(serverId)}/expressions`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type, 'X-Expression-Name': encodeURIComponent(name), 'X-Expression-Kind': kind, 'X-Expression-Scope': scope, ...(groupId ? { 'X-Expression-Group': groupId } : {}) }, body: file })
      const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `表情上传失败 (${response.status})`); return body
    },
    createExpressionGroup: (serverId, kind, name, scope = 'personal') => request(`/servers/${encodeURIComponent(serverId)}/expression-groups`, { method: 'POST', body: JSON.stringify({ kind, name, scope }) }),
    renameExpressionGroup: (groupId, name) => request(`/expression-groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    deleteExpressionGroup: (groupId) => request(`/expression-groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),
    async getExpressionBlob(id) { const response = await fetch(`${base}/api/v1/expressions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${getToken()}` } }); if (!response.ok) throw new Error(`表情加载失败 (${response.status})`); return response.blob() },
    deleteExpression: (id) => request(`/expressions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getAiAgents: (serverId) => request(`/ai/servers/${encodeURIComponent(serverId)}/agents`),
    getAiTtsConfig: (serverId) => request(`/ai/servers/${encodeURIComponent(serverId)}/tts`),
    saveAiTtsConfig: (serverId, input) => request(`/ai/servers/${encodeURIComponent(serverId)}/tts`, { method: 'PUT', body: JSON.stringify(input) }),
    testAiTtsConfig: (serverId) => request(`/ai/servers/${encodeURIComponent(serverId)}/tts/test`, { method: 'POST' }),
    async getAiStickerBlob(id) { const response = await fetch(`${base}/api/v1/ai/stickers/${encodeURIComponent(id)}/image`, { headers: { Authorization: `Bearer ${getToken()}` } }); if (!response.ok) throw new Error(`机器人表情加载失败 (${response.status})`); return response.blob() },
    getAiStickers: (agentId) => request(`/ai/agents/${encodeURIComponent(agentId)}/stickers`),
    async uploadAiSticker(agentId, file, name, emotion, description, scope = 'agent') {
      const response = await fetch(`${base}/api/v1/ai/agents/${encodeURIComponent(agentId)}/stickers`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type, 'X-Bot-Sticker-Name': encodeURIComponent(name), 'X-Bot-Sticker-Emotion': encodeURIComponent(emotion), 'X-Bot-Sticker-Description': encodeURIComponent(description), 'X-Bot-Sticker-Scope': scope }, body: file })
      const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `机器人表情上传失败 (${response.status})`); return body
    },
    deleteAiSticker: (agentId, stickerId) => request(`/ai/agents/${encodeURIComponent(agentId)}/stickers/${encodeURIComponent(stickerId)}`, { method: 'DELETE' }),
    createAiAgent: (serverId, input) => request(`/ai/servers/${encodeURIComponent(serverId)}/agents`, { method: 'POST', body: JSON.stringify(input) }),
    updateAiAgent: (agentId, input) => request(`/ai/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    saveAiProvider: (agentId, input) => request(`/ai/agents/${encodeURIComponent(agentId)}/provider`, { method: 'PUT', body: JSON.stringify(input) }),
    testAiProvider: (agentId) => request(`/ai/agents/${encodeURIComponent(agentId)}/provider/test`, { method: 'POST' }),
    updateAiInstallations: (agentId, channels) => request(`/ai/agents/${encodeURIComponent(agentId)}/installations`, { method: 'PUT', body: JSON.stringify({ channels }) }),
    updateAiTools: (agentId, tools) => request(`/ai/agents/${encodeURIComponent(agentId)}/tools`, { method: 'PUT', body: JSON.stringify({ tools }) }),
    getAiConversation: (agentId) => request(`/ai/agents/${encodeURIComponent(agentId)}/conversation`),
    async getAiDirectAudioBlob(agentId, messageId) { const response = await fetch(`${base}/api/v1/ai/agents/${encodeURIComponent(agentId)}/conversation/messages/${encodeURIComponent(messageId)}/audio`, { headers: { Authorization: `Bearer ${getToken()}` } }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `机器人语音加载失败 (${response.status})`) } return response.blob() },
    sendAiDirectMessage: (agentId, content) => request(`/ai/agents/${encodeURIComponent(agentId)}/conversation/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
    clearAiConversation: (agentId) => request(`/ai/agents/${encodeURIComponent(agentId)}/conversation`, { method: 'DELETE' }),
    getMessages: (channelId, options = {}) => { const params = new URLSearchParams(); if (options.before) params.set('before', options.before); if (options.after) params.set('after', options.after); if (options.query) params.set('q', options.query); if (options.authorId) params.set('authorId', options.authorId); if (options.fromDate) params.set('fromDate', localDateBoundary(options.fromDate)); if (options.toDate) params.set('toDate', localDateBoundary(options.toDate, true)); if (options.hasImage) params.set('hasImage', 'true'); if (options.limit) params.set('limit', String(options.limit)); return request(`/channels/${encodeURIComponent(channelId)}/messages${params.size ? `?${params}` : ''}`) },
    searchServerMessages: (serverId, options = {}) => { const params = new URLSearchParams(); if (options.before) params.set('before', options.before); if (options.query) params.set('q', options.query); if (options.authorId) params.set('authorId', options.authorId); if (options.fromDate) params.set('fromDate', localDateBoundary(options.fromDate)); if (options.toDate) params.set('toDate', localDateBoundary(options.toDate, true)); if (options.hasImage) params.set('hasImage', 'true'); if (options.limit) params.set('limit', String(options.limit)); return request(`/servers/${encodeURIComponent(serverId)}/messages/search?${params}`) },
    getPins: (channelId) => request(`/channels/${encodeURIComponent(channelId)}/pins`),
    getMessageContext: (messageId) => request(`/messages/${encodeURIComponent(messageId)}/context`),
    markChannelRead: (channelId, messageId) => request(`/channels/${encodeURIComponent(channelId)}/read-state`, { method: 'PUT', body: JSON.stringify({ messageId }) }),
    async uploadAttachment(channelId, file) {
      const response = await fetch(`${base}/api/v1/channels/${encodeURIComponent(channelId)}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { const error = new Error(body.error || `图片上传失败 (${response.status})`); error.status = response.status; if (response.status === 401) emit({ type: 'auth.expired', data: {} }); throw error }
      return body
    },
    async uploadVoiceMessage(channelId, file, durationMs) {
      const response = await fetch(`${base}/api/v1/channels/${encodeURIComponent(channelId)}/audio`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type.split(';')[0], 'X-File-Name': encodeURIComponent(file.name), 'X-Audio-Duration-Ms': String(durationMs) }, body: file })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { const error = new Error(body.error || `语音上传失败 (${response.status})`); error.status = response.status; if (response.status === 401) emit({ type: 'auth.expired', data: {} }); throw error }
      return body
    },
    async getAttachmentBlob(attachmentId) {
      const response = await fetch(`${base}/api/v1/attachments/${encodeURIComponent(attachmentId)}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `图片加载失败 (${response.status})`) }
      return response.blob()
    },
    deleteAttachment: (attachmentId) => request(`/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }),
    createChannel: (serverId, input) => request(`/servers/${encodeURIComponent(serverId)}/channels`, { method: 'POST', body: JSON.stringify(input) }),
    sendMessage: (channelId, input) => request(`/channels/${encodeURIComponent(channelId)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
    editMessage: (messageId, content) => request(`/messages/${encodeURIComponent(messageId)}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
    deleteMessage: (messageId) => request(`/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }),
    toggleReaction: (messageId, emoji) => request(`/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`, { method: 'PUT' }),
    togglePin: (messageId) => request(`/messages/${encodeURIComponent(messageId)}/pin`, { method: 'PUT' }),
    getVoiceToken: (channelId) => request('/voice/token', { method: 'POST', body: JSON.stringify({ channelId }) }),
    setVoicePresence: (channelId, connected) => request('/voice/presence', { method: 'POST', body: JSON.stringify({ channelId, connected }) }),
    listGameRooms: (serverId) => request(`/servers/${encodeURIComponent(serverId)}/game-rooms`),
    previewGameRoom: (roomId, inviteCode) => request(`/game-rooms/${encodeURIComponent(roomId)}/preview`, { method: 'POST', body: JSON.stringify({ inviteCode }) }),
    hasGameSession: (roomId) => Boolean(readRoomState().sessions?.[roomId]),
    forgetGameSession(roomId) { const state = readRoomState(); delete state.sessions?.[roomId]; delete state.invites?.[roomId]; if (state.activeRoomId === roomId) state.activeRoomId = null; writeRoomState(state) },
    getGameMessages: (roomId) => request(`/game-rooms/${encodeURIComponent(roomId)}/messages`),
    sendGameMessage: (roomId, content) => request(`/game-rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
    async createGameInvite(roomId) { const result = await request(`/game-rooms/${encodeURIComponent(roomId)}/invite`, { method: 'POST' }); const state = readRoomState(); state.invites ||= {}; state.invites[roomId] = result.inviteCode; writeRoomState(state); return result.inviteCode },
    getActiveGameRoomId: () => readRoomState().activeRoomId || null,
    async createGameRoom(serverId, input) {
      const result = await request(`/servers/${encodeURIComponent(serverId)}/game-rooms`, { method: 'POST', body: JSON.stringify(input) })
      const state = readRoomState(); state.activeRoomId = result.room.id; state.sessions ||= {}; state.sessions[result.room.id] = result.sessionToken; state.invites ||= {}; state.invites[result.room.id] = result.inviteCode; state.members ||= {}; state.members[result.room.id] = result.room.hostMemberId; writeRoomState(state)
      return { ...result.room, currentMemberId: result.room.hostMemberId, role: 'host' }
    },
    async joinGameRoom(roomId, inviteCode, displayName) {
      const result = await request(`/game-rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: JSON.stringify({ inviteCode, displayName }) })
      const state = readRoomState(); state.activeRoomId = result.room.id; state.sessions ||= {}; state.sessions[result.room.id] = result.sessionToken; state.members ||= {}; state.members[result.room.id] = result.memberId; writeRoomState(state)
      return { ...result.room, currentMemberId: result.memberId, role: result.role }
    },
    async getGameRoom(roomId) { const result = await request(`/game-rooms/${encodeURIComponent(roomId)}`); return { ...result.room, currentMemberId: result.memberId, role: result.role } },
    getGameInviteCode: (roomId) => readRoomState().invites?.[roomId] || null,
    async setGameMemberStatus(roomId, memberStatus, roomStatus) { const result = await request(`/game-rooms/${encodeURIComponent(roomId)}/status`, { method: 'PUT', body: JSON.stringify({ memberStatus, roomStatus }) }); return { ...result.room, currentMemberId: result.memberId, role: result.role } },
    async leaveGameRoom(roomId, endRoom = false) { const result = await request(`/game-rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST', body: JSON.stringify({ endRoom }) }); const state = readRoomState(); delete state.sessions?.[roomId]; delete state.invites?.[roomId]; if (state.activeRoomId === roomId) state.activeRoomId = null; writeRoomState(state); return result },
    getGameVoiceToken: (roomId) => request(`/game-rooms/${encodeURIComponent(roomId)}/voice-token`, { method: 'POST' }),
    subscribe(type, listener) { listeners.set(type, listeners.get(type) || new Set()); listeners.get(type).add(listener); return () => listeners.get(type)?.delete(listener) },
    close() { stopped = true; clearTimeout(retryTimer); socket?.close() },
  }
  window.addEventListener('pagehide', () => window.EchoApi.close(), { once: true })
})()
