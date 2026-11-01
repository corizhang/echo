(() => {
  const FIXTURES = window.EchoFixtures
  const STORAGE_KEY = 'echo.mock.v1'
  const ROOM_STORAGE_KEY = 'echo.game-room.v1'
  const listeners = new Map()
  const mockAttachments = new Map()
  const mockExpressions = new Map()
  let expressionAssets = []
  let expressionGroups = []
  const clone = (value) => JSON.parse(JSON.stringify(value))
  let state = clone(FIXTURES)
  let readCursors = {}
  try { state.gameRooms = JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}').rooms || {} } catch { state.gameRooms = {} }
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const previous = JSON.parse(saved)
      state.messages = { ...state.messages, ...previous.messages }
      readCursors = previous.readCursors || {}
      if (Array.isArray(previous.channels)) state.channels.push(...previous.channels.filter((channel) => !state.channels.some((item) => item.id === channel.id)))
      expressionAssets = Array.isArray(previous.expressionAssets) ? previous.expressionAssets : []
      expressionGroups = Array.isArray(previous.expressionGroups) ? previous.expressionGroups : []
    }
  } catch { /* Browser storage can be unavailable in private modes. */ }

  function persist() {
    const messages = Object.fromEntries(Object.entries(state.messages).map(([channelId, items]) => [channelId, items.map((message) => ({ ...message, attachments: (message.attachments || []).map(({ mockDataUrl, ...attachment }) => attachment) }))]))
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, readCursors, channels: state.channels.filter((channel) => channel.id.startsWith('channel-')), expressionAssets, expressionGroups })) } catch { /* In-memory mock remains usable. */ }
  }
  function roomState() { try { return JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || '{}') } catch { return {} } }
  function saveRoomState(next) { try { localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(next)) } catch { /* In-memory mock remains usable. */ } }
  const AI_STORAGE_KEY = 'echo.mock.ai.v1'
  let aiState
  try { aiState = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) || 'null') } catch { aiState = null }
  if (!aiState) aiState = { agents: [{ id: 'agent-whale', serverId: 'server-squad', botUserId: 'user-whale', name: '鲸鱼娘', description: '和小队一起聊天的 AI 伙伴', persona: '你是鲸鱼娘，喜欢和朋友自然聊天，简短、有趣、尊重每个人。', provider: 'deepseek', model: 'deepseek-flash', temperature: 0.8, maxOutputTokens: 700, enabled: true, imageUnderstandingEnabled: false, webSearchEnabled: false, stickerSendingEnabled: true, voiceRepliesEnabled: false, providerConfigured: false, keySuffix: '', installations: state.channels.filter((channel) => channel.serverId === 'server-squad' && channel.type === 'text').map((channel) => ({ channelId: channel.id, enabled: true, triggerMode: 'mention', cooldownSeconds: 15 })) }], conversations: {}, stickers: [], ttsConfig: null }
  aiState.ttsConfig ??= null
  aiState.stickers ||= []
  function saveAiMock() { try { localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiState)) } catch { /* In-memory mock remains usable. */ } }
  function emit(type, payload) {
    for (const listener of listeners.get(type) || []) listener(clone(payload))
  }
  function applyMessageSearchFilters(messages, options = {}) {
    let results = messages.filter((message) => !message.deletedAt)
    if (options.query) { const query = options.query.toLocaleLowerCase(); results = results.filter((message) => message.content.toLocaleLowerCase().includes(query) || message.author.toLocaleLowerCase().includes(query)) }
    if (options.authorId) results = results.filter((message) => message.authorId === options.authorId)
    if (options.fromDate) results = results.filter((message) => localDateKey(message.createdAt) >= options.fromDate)
    if (options.toDate) results = results.filter((message) => localDateKey(message.createdAt) <= options.toDate)
    if (options.hasImage) results = results.filter((message) => message.attachments?.some((attachment) => attachment.mimeType?.startsWith('image/')))
    return results
  }
  function localDateKey(value) { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
  function pageBefore(messages, before, limit = 50) {
    if (!before) return { messages: messages.slice(-limit), hasMore: messages.length > limit, before: messages[Math.max(0, messages.length - limit)]?.id || null }
    const index = messages.findIndex((message) => message.id === before)
    if (index < 0) return { messages: [], hasMore: false, before: null }
    const page = messages.slice(Math.max(0, index - limit), index)
    return { messages: page, hasMore: index > limit, before: page[0]?.id || null }
  }

  window.EchoApi = {
    mode: 'mock',
    async getMe() { return clone(state.currentUser) },
    async getServers() { return clone(state.servers) },
    async getChannels(serverId) { return clone(state.channels.filter((item) => item.serverId === serverId).map((channel) => { const list = state.messages[channel.id] || []; const cursor = list.findIndex((message) => message.id === readCursors[channel.id]); const unreadItems = readCursors[channel.id] ? list.slice(Math.max(0, cursor + 1)).filter((message) => !message.deletedAt) : list.slice(Math.max(0, list.length - (channel.unread || 0))).filter((message) => !message.deletedAt); return { ...channel, unread: channel.type === 'text' ? unreadItems.length : 0, unreadMessageId: channel.type === 'text' ? unreadItems[0]?.id || null : null } })) },
    async getMessages(channelId, options = {}) {
      let messages = [...(state.messages[channelId] || [])]
      if (options.query || options.authorId || options.fromDate || options.toDate || options.hasImage) messages = applyMessageSearchFilters(messages, options)
      if (options.before) { const page = pageBefore(messages, options.before, options.limit || 50); return clone(page) }
      if (options.after) { const index = messages.findIndex((message) => message.id === options.after); const total = messages.length; messages = index < 0 ? [] : messages.slice(index + 1, index + 1 + (options.limit || 50)); return { messages: clone(messages), hasMore: index + 1 + (options.limit || 50) < total, after: messages.at(-1)?.id || null } }
      const limit = options.limit || 50; return { messages: clone(messages.slice(-limit)), hasMore: messages.length > limit, before: messages[Math.max(0, messages.length - limit)]?.id || null }
    },
    async searchServerMessages(serverId, options = {}) {
      if (!options.query && !options.authorId && !options.fromDate && !options.toDate && !options.hasImage) return { messages: [], hasMore: false, before: null }
      const channels = state.channels.filter((channel) => channel.serverId === serverId && channel.type === 'text')
      let messages = channels.flatMap((channel) => (state.messages[channel.id] || []).map((message) => ({ ...message, channelName: channel.name })))
      messages = applyMessageSearchFilters(messages, options).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return clone(pageBefore(messages, options.before, options.limit || 50))
    },
    async getPins(channelId) { return { messages: clone((state.messages[channelId] || []).filter((message) => message.pinned)) } },
    async getMessageContext(messageId) {
      const channelId = Object.keys(state.messages).find((id) => state.messages[id].some((message) => message.id === messageId)); const list = state.messages[channelId] || []; const index = list.findIndex((message) => message.id === messageId)
      if (index < 0) throw new Error('找不到消息')
      return { messages: clone(list.slice(Math.max(0, index - 20), index + 21)), hasOlder: index > 20, hasNewer: index + 21 < list.length, channelId }
    },
    async markChannelRead(channelId, messageId) { readCursors[channelId] = messageId; persist(); return { ok: true, messageId } },
    async getMembers(serverId) {
      const members = state.members.filter((member) => serverId === 'server-squad' || member.id !== 'user-kira')
      const bots = aiState.agents.filter((agent) => agent.serverId === serverId && agent.enabled).map((agent) => ({ id: agent.botUserId, username: agent.name.toLocaleLowerCase().replace(/\s+/g, '-'), displayName: agent.name, avatar: 'AI', color: 'violet', status: 'online', activity: 'AI 伙伴', isBot: true }))
      return clone([...members, ...bots])
    },
    async getExpressions(serverId) { const assets = expressionAssets.filter((item) => item.serverId === serverId && !item.deletedAt && ((item.scope || 'personal') === 'system' || item.ownerUserId === state.currentUser.id)); const groups = expressionGroups.filter((item) => item.serverId === serverId && ((item.scope || (item.source === 'builtin' ? 'system' : 'personal')) === 'system' || item.ownerUserId === state.currentUser.id)); return clone({ emojis: assets.filter((item) => item.kind === 'emoji'), stickers: assets.filter((item) => item.kind === 'sticker'), groups: { emoji: groups.filter((item) => item.kind === 'emoji'), sticker: groups.filter((item) => item.kind === 'sticker') }, canUpload: true, canManageGroups: true, canManageSystem: false }) },
    async createExpressionGroup(serverId, kind, name, scope = 'personal') { name = String(name || '').trim(); if (!['emoji','sticker'].includes(kind) || !name || [...name].length > 32) throw new Error('分组名称需为 1–32 个字符'); if (expressionGroups.some((group) => group.serverId === serverId && group.kind === kind && group.scope === scope && group.ownerUserId === (scope === 'personal' ? state.currentUser.id : null) && group.name.toLowerCase() === name.toLowerCase())) throw new Error('这个分组名称已经存在'); const group = { id: `expr-group-${crypto.randomUUID()}`, serverId, kind, name, scope, ownerUserId: scope === 'personal' ? state.currentUser.id : null, source: scope === 'system' ? 'builtin' : 'user' }; expressionGroups.push(group); persist(); return { group: clone(group) } },
    async renameExpressionGroup(groupId, name) { const group = expressionGroups.find((item) => item.id === groupId && item.source !== 'builtin'); if (!group) throw new Error('找不到可管理的自建分组'); name = String(name || '').trim(); if (!name || [...name].length > 32) throw new Error('分组名称需为 1–32 个字符'); if (expressionGroups.some((item) => item.id !== groupId && item.serverId === group.serverId && item.kind === group.kind && item.name.toLowerCase() === name.toLowerCase())) throw new Error('这个分组名称已经存在'); group.name = name; persist(); return { group: clone(group) } },
    async deleteExpressionGroup(groupId) { const group = expressionGroups.find((item) => item.id === groupId && item.source !== 'builtin'); if (!group) throw new Error('找不到可删除的自建分组'); expressionGroups = expressionGroups.filter((item) => item !== group); expressionAssets.filter((item) => item.groupId === groupId).forEach((item) => { item.groupId = null }); persist(); return { ok: true } },
    async uploadExpression(serverId, kind, file, name, groupId = '', scope = 'personal') {
      const allowed = new Set(['image/png','image/jpeg','image/gif','image/webp']); if (!allowed.has(file.type)) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片')
      const max = kind === 'emoji' ? 256 * 1024 : 2 * 1024 * 1024; if (!file.size || file.size > max) throw new Error(kind === 'emoji' ? '自定义 Emoji 最大 256 KB' : '表情包最大 2 MB')
      if (expressionAssets.filter((item) => item.serverId === serverId && !item.deletedAt && item.scope === scope && item.ownerUserId === (scope === 'personal' ? state.currentUser.id : null)).length >= 200) throw new Error('表情库已达到 200 项上限')
      if (kind === 'emoji' && !/^[a-zA-Z0-9_]{2,32}$/.test(name)) throw new Error('Emoji 名称需为 2–32 位英文字母、数字或下划线')
      if (expressionAssets.some((item) => item.serverId === serverId && item.kind === kind && item.name.toLowerCase() === name.toLowerCase() && !item.deletedAt && (item.scope || 'personal') === scope && item.ownerUserId === (scope === 'personal' ? state.currentUser.id : null))) throw new Error('这个名称已经被使用')
      const mockDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      if (groupId && !expressionGroups.some((item) => item.id === groupId && item.serverId === serverId && item.kind === kind && item.scope === scope && item.ownerUserId === (scope === 'personal' ? state.currentUser.id : null))) throw new Error('所选分组不存在或类型不匹配')
      const expression = { id: `mock-expr-${crypto.randomUUID()}`, serverId, kind, name, groupId: groupId || null, scope, isBuiltin: scope === 'system', mimeType: file.type, sizeBytes: file.size, ownerUserId: scope === 'personal' ? state.currentUser.id : null, mockDataUrl, createdAt: new Date().toISOString() }
      expressionAssets.push(expression); mockExpressions.set(expression.id, expression); persist(); emit('expression.created', { serverId, expression }); return { expression: clone(expression) }
    },
    async getExpressionBlob(id) { const item = expressionAssets.find((asset) => asset.id === id); const sent = Object.values(state.messages).some((messages) => messages.some((message) => message.sticker?.id === id)); if (!item?.mockDataUrl || ((item.scope || 'personal') === 'personal' && item.ownerUserId !== state.currentUser.id && !sent)) throw new Error('表情不存在或无权访问'); return fetch(item.mockDataUrl).then((response) => response.blob()) },
    async deleteExpression(id) { const item = expressionAssets.find((asset) => asset.id === id && asset.ownerUserId === state.currentUser.id && !asset.deletedAt); if (!item) throw new Error('找不到可删除的表情，或你不是上传者'); item.deletedAt = new Date().toISOString(); persist(); emit('expression.deleted', { serverId: item.serverId, expressionId: item.id }); return { ok: true } },
    async getAiAgents(serverId) { return { agents: clone(aiState.agents.filter((agent) => agent.serverId === serverId).map((agent) => ({ ...agent, voiceRepliesEnabled: agent.voiceRepliesEnabled === true, canManage: true }))), canManage: true, canCreate: true } },
    async getAiTtsConfig() { return { ...(clone(aiState.ttsConfig) || { configured: false, provider: 'doubao', baseUrl: '', model: 'seed-tts-2.0-standard', voice: '', resourceId: 'seed-tts-2.0' }), canManage: true } },
    async saveAiTtsConfig(serverId, input) { aiState.ttsConfig = { configured: true, provider: input.provider || 'doubao', baseUrl: input.baseUrl, model: input.model, voice: input.voice, resourceId: input.resourceId || 'seed-tts-2.0', keySuffix: String(input.apiKey || aiState.ttsConfig?.keySuffix || '').slice(-4) }; saveAiMock(); return { ...clone(aiState.ttsConfig), canManage: true, mock: true } },
    async testAiTtsConfig() { if (!aiState.ttsConfig?.configured) throw new Error('请先保存 TTS 服务配置'); return { ok: true, latencyMs: 48, durationMs: 1100, audioBytes: 24000, mock: true } },
    async getAiStickers(agentId) { const stickers = aiState.stickers.filter((item) => item.scope === 'system' || item.agentId === agentId); return { stickers: clone(stickers), canManage: true, canManageSystem: true } },
    async getAiStickerBlob(stickerId) { const sticker = aiState.stickers.find((item) => item.id === stickerId); if (!sticker?.mockDataUrl) throw new Error('Mock 表情预览不存在'); return fetch(sticker.mockDataUrl).then((response) => response.blob()) },
    async uploadAiSticker(agentId, file, name, emotion, description, scope = 'agent') { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); const item = { id: `mock-aistg-${crypto.randomUUID()}`, agentId: scope === 'system' ? null : agentId, scope, name, emotion, groupName: emotion, description, mimeType: file.type, sizeBytes: file.size, mockDataUrl: `data:${file.type};base64,${btoa(binary)}` }; aiState.stickers.push(item); saveAiMock(); return { sticker: clone(item), mock: true } },
    async deleteAiSticker(agentId, stickerId) { const item = aiState.stickers.find((sticker) => sticker.id === stickerId && (sticker.scope === 'system' || sticker.agentId === agentId)); if (!item) throw new Error('找不到表情'); aiState.stickers = aiState.stickers.filter((sticker) => sticker !== item); saveAiMock(); return { ok: true, mock: true } },
    async createAiAgent(serverId, input) {
      const agent = { ...clone(input), id: `agent-${crypto.randomUUID()}`, serverId, botUserId: `bot-${crypto.randomUUID()}`, provider: 'deepseek', model: 'deepseek-flash', temperature: 0.8, maxOutputTokens: 700, enabled: true, imageUnderstandingEnabled: false, webSearchEnabled: false, stickerSendingEnabled: true, providerConfigured: false, keySuffix: '', installations: state.channels.filter((channel) => channel.serverId === serverId && channel.type === 'text').map((channel) => ({ channelId: channel.id, enabled: false, triggerMode: 'mention', cooldownSeconds: 15 })) }
      aiState.agents.push(agent); saveAiMock(); return { agent: clone(agent) }
    },
    async updateAiAgent(agentId, input) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent) throw new Error('找不到机器人'); Object.assign(agent, clone(input)); saveAiMock(); return { agent: clone(agent) } },
    async saveAiProvider(agentId, input) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent) throw new Error('找不到机器人'); agent.providerConfigured = true; agent.keySuffix = String(input.apiKey || '').slice(-4); saveAiMock(); return { configured: true, provider: 'deepseek', keySuffix: agent.keySuffix, mock: true } },
    async testAiProvider(agentId) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent?.providerConfigured) throw new Error('请先保存 API Key'); return { ok: true, provider: 'deepseek', latencyMs: 42, availableModels: ['deepseek-flash', 'deepseek-v4-pro'], mock: true } },
    async updateAiInstallations(agentId, channels) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent) throw new Error('找不到机器人'); agent.installations = clone(channels); saveAiMock(); return { ok: true } },
    async updateAiTools(agentId, tools) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent) throw new Error('找不到机器人'); agent.imageUnderstandingEnabled = (tools || []).some((tool) => tool.key === 'image.read'); agent.webSearchEnabled = (tools || []).some((tool) => tool.key === 'web.search'); agent.stickerSendingEnabled = (tools || []).some((tool) => tool.key === 'sticker.send'); saveAiMock(); return { tools: [{ key: 'image.read', enabled: agent.imageUnderstandingEnabled }, { key: 'web.search', enabled: agent.webSearchEnabled }, { key: 'sticker.send', enabled: agent.stickerSendingEnabled }], mock: true } },
    async getAiConversation(agentId) { const agent = aiState.agents.find((item) => item.id === agentId); if (!agent) throw new Error('找不到机器人'); const key = `${state.currentUser.id}:${agentId}`; aiState.conversations[key] ||= []; return { conversation: { id: key }, agent: clone(agent), messages: clone(aiState.conversations[key]) } },
    async getAiDirectAudioBlob() { throw new Error('Mock 演示模式没有生成真实语音') },
    async sendAiDirectMessage(agentId, content) { const result = await this.getAiConversation(agentId); const history = aiState.conversations[result.conversation.id]; const now = new Date().toISOString(); const userMessage = { id: crypto.randomUUID(), senderType: 'user', senderUserId: state.currentUser.id, content, status: 'completed', createdAt: now }; const answer = { id: crypto.randomUUID(), senderType: 'assistant', senderUserId: result.agent.botUserId, content: `（Mock 演示回复）我听到了：“${content.slice(0, 80)}”`, status: 'completed', createdAt: new Date().toISOString() }; history.push(userMessage, answer); saveAiMock(); emit('ai.direct.message.created', { conversationId: result.conversation.id, message: answer }); return { conversationId: result.conversation.id, messages: [clone(userMessage), clone(answer)] } },
    async clearAiConversation(agentId) { delete aiState.conversations[`${state.currentUser.id}:${agentId}`]; saveAiMock(); return { ok: true } },
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
      if (!content && !input.attachmentIds?.length && !input.audioAttachmentId && !input.stickerId) throw new Error('消息内容、图片、语音或表情包不能为空')
      const mentions = (Array.isArray(input.mentions) ? input.mentions : []).filter((mention) => Number.isInteger(mention.start) && Number.isInteger(mention.end) && content.slice(mention.start, mention.end).startsWith('@'))
      const imageAttachments = (input.attachmentIds || []).map((id) => mockAttachments.get(id)).filter((item) => item?.mimeType?.startsWith('image/'))
      const audioAttachment = input.audioAttachmentId ? mockAttachments.get(input.audioAttachmentId) : null
      if (input.attachmentIds?.length !== imageAttachments.length) throw new Error('图片上传已失效，请重新选择图片')
      if (input.audioAttachmentId && !audioAttachment?.mimeType?.startsWith('audio/')) throw new Error('录音上传已失效，请重新录制')
      const attachments = [...imageAttachments, ...(audioAttachment ? [audioAttachment] : [])]
      const stickerAsset = input.stickerId ? expressionAssets.find((item) => item.id === input.stickerId && item.kind === 'sticker' && !item.deletedAt && ((item.scope || 'personal') === 'system' || item.ownerUserId === state.currentUser.id)) : null
      if (input.stickerId && !stickerAsset) throw new Error('这个表情包已不可用')
      const message = { id: `m-${crypto.randomUUID()}`, channelId, authorId: state.currentUser.id, author: state.currentUser.displayName, avatar: state.currentUser.avatar, color: 'blue', createdAt: new Date().toISOString(), content, mentions, attachments: clone(attachments), sticker: stickerAsset ? clone(stickerAsset) : null, replyTo: input.replyTo || null, pinned: false, reactions: [] }
      state.messages[channelId] ||= []
      state.messages[channelId].push(message)
      readCursors[channelId] = message.id
      persist()
      emit('message.created', message)
      return clone(message)
    },
    async uploadAttachment(channelId, file) {
      if (!state.channels.some((channel) => channel.id === channelId && channel.type === 'text')) throw new Error('请选择文字频道后上传图片')
      if (file.size > 2 * 1024 * 1024) throw new Error('Mock 演示模式的图片上限为 2 MB')
      const mockDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      const attachment = { id: `mock-att-${crypto.randomUUID()}`, fileName: file.name, mimeType: file.type, sizeBytes: file.size, mockDataUrl }
      mockAttachments.set(attachment.id, attachment)
      return { attachment: clone(attachment) }
    },
    async uploadVoiceMessage(channelId, file, durationMs) {
      if (!state.channels.some((channel) => channel.id === channelId && channel.type === 'text')) throw new Error('请选择文字频道后发送语音')
      if (!['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'].includes(file.type.split(';')[0]) || file.size > 2 * 1024 * 1024) throw new Error('Mock 演示模式仅支持 2 MB 以内的常见音频格式')
      if (durationMs < 500 || durationMs > 120_000) throw new Error('语音时长需在 0.5 秒到 2 分钟之间')
      const mockDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取录音失败')); reader.readAsDataURL(file) })
      const attachment = { id: `mock-att-${crypto.randomUUID()}`, fileName: file.name, mimeType: file.type.split(';')[0], sizeBytes: file.size, durationMs, mockDataUrl }
      mockAttachments.set(attachment.id, attachment); return { attachment: clone(attachment) }
    },
    async deleteAttachment(attachmentId) { mockAttachments.delete(attachmentId); return { ok: true } },
    async toggleReaction(messageId, emoji) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message || message.deletedAt) throw new Error('找不到消息')
      const reaction = message.reactions.find((item) => item.emoji === emoji)
      if (reaction) { reaction.count += reaction.reacted ? -1 : 1; reaction.reacted = !reaction.reacted; if (reaction.count <= 0) message.reactions = message.reactions.filter((item) => item !== reaction) }
      else message.reactions.push({ emoji, count: 1, reacted: true })
      persist(); emit('message.updated', message); return clone(message)
    },
    async togglePin(messageId) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message || message.deletedAt) throw new Error('找不到消息')
      message.pinned = !message.pinned; persist(); emit('message.updated', message); return clone(message)
    },
    async editMessage(messageId, content) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message || message.authorId !== state.currentUser.id || message.deletedAt) throw new Error('找不到消息或无权编辑')
      const value = String(content || '').trim()
      if (value.length > 4000) throw new Error('消息长度不能超过 4000 个字符')
      if (!value && !message.attachments?.length) throw new Error('消息内容不能为空')
      message.content = value; message.mentions = []; message.editedAt = new Date().toISOString(); persist(); emit('message.updated', message); return clone(message)
    },
    async deleteMessage(messageId) {
      const message = Object.values(state.messages).flat().find((item) => item.id === messageId)
      if (!message || message.authorId !== state.currentUser.id || message.deletedAt) throw new Error('找不到消息或无权删除')
      for (const attachment of message.attachments || []) mockAttachments.delete(attachment.id)
      message.content = ''; message.mentions = []; message.attachments = []; message.reactions = []; message.pinned = false; message.deletedAt = new Date().toISOString(); persist(); emit('message.updated', message); return { ok: true, id: messageId, channelId: message.channelId, deletedAt: message.deletedAt }
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
