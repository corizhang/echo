(() => {
  const FIXTURES = window.EchoFixtures
  const STORAGE_KEY = 'echo.mock.v1'
  const listeners = new Map()
  const clone = (value) => JSON.parse(JSON.stringify(value))
  let state = clone(FIXTURES)
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
    subscribe(type, listener) {
      listeners.set(type, listeners.get(type) || new Set()); listeners.get(type).add(listener)
      return () => listeners.get(type)?.delete(listener)
    },
  }
})()
