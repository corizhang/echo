(() => {
  if (location.protocol === 'file:') return
  const listeners = new Map()
  const request = async (path, options = {}) => {
    const response = await fetch(`/api/v1${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`)
    return body
  }
  const emit = (event) => { for (const listener of listeners.get(event.type) || []) listener(event.data) }
  let socket, retryTimer, stopped = false
  function connectEvents() {
    if (stopped) return
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/events`)
    socket.onmessage = ({ data }) => { try { emit(JSON.parse(data)) } catch (error) { console.warn('Invalid event', error) } }
    socket.onclose = () => { if (!stopped) retryTimer = setTimeout(connectEvents, 2500) }
  }
  connectEvents()

  window.EchoApi = {
    mode: 'http',
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
    subscribe(type, listener) { listeners.set(type, listeners.get(type) || new Set()); listeners.get(type).add(listener); return () => listeners.get(type)?.delete(listener) },
    close() { stopped = true; clearTimeout(retryTimer); socket?.close() },
  }
  window.addEventListener('pagehide', () => window.EchoApi.close(), { once: true })
})()
