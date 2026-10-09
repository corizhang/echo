(() => {
  if (location.protocol === 'file:') return
  const base = window.EchoDesktop ? window.EchoServerUrl : location.origin
  const listeners = new Map()
  const AUTH_TOKEN_KEY = 'echo.auth.v1'
  const getToken = () => localStorage.getItem(AUTH_TOKEN_KEY) || ''
  const ROOM_STORAGE_KEY = 'echo.game-room.v1'
  const readRoomState = () => { try { return JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}') } catch { return {} } }
  const writeRoomState = (state) => localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(state))
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
    getMessages: (channelId) => request(`/channels/${encodeURIComponent(channelId)}/messages`),
    createChannel: (serverId, input) => request(`/servers/${encodeURIComponent(serverId)}/channels`, { method: 'POST', body: JSON.stringify(input) }),
    sendMessage: (channelId, input) => request(`/channels/${encodeURIComponent(channelId)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
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
