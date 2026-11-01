(() => {
  const api = window.EchoApi
  const $ = (selector) => document.querySelector(selector)
  if (!api || !$('#ai-agent-list')) return
  let agents = []
  let activeAgentId = null
  let conversationId = null
  let busy = false
  let audioObjectUrls = []

  function escapeText(value) { return String(value || '') }
  function appendTextWithLinks(target, text) {
    const value = escapeText(text); const pattern = /https?:\/\/[^\s<>"']+/giu; let offset = 0
    for (const match of value.matchAll(pattern)) {
      let raw = match[0]; const trailing = raw.match(/[).,!?;:，。！？、】）]+$/u)?.[0] || ''; if (trailing) raw = raw.slice(0, -trailing.length)
      target.append(document.createTextNode(value.slice(offset, match.index)))
      try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link protocol'); const link = document.createElement('a'); link.href = url.toString(); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'message-link'; link.textContent = raw; target.append(link) } catch { target.append(document.createTextNode(raw)) }
      if (trailing) target.append(document.createTextNode(trailing)); offset = match.index + match[0].length
    }
    target.append(document.createTextNode(value.slice(offset)))
  }
  function renderMessages(messages) {
    audioObjectUrls.forEach((url) => URL.revokeObjectURL(url)); audioObjectUrls = []
    const list = $('#ai-chat-messages'); list.replaceChildren()
    if (!messages.length) {
      const empty = document.createElement('div'); empty.className = 'ai-chat-empty'
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.classList.add('icon'); icon.innerHTML = '<use href="#i-sparkles"></use>'
      const title = document.createElement('strong'); title.textContent = `开始和${$('#ai-chat-title').textContent}聊天吧`
      const copy = document.createElement('span'); copy.textContent = '这里是只对你开放的私聊空间。'
      empty.append(icon, title, copy); list.append(empty); return
    }
    for (const message of messages) {
      const row = document.createElement('article'); row.className = `ai-chat-message ${message.senderType === 'assistant' ? 'assistant' : 'user'}`
      const avatar = document.createElement('div'); avatar.className = `ai-chat-message-avatar ${message.senderType}`; avatar.textContent = message.senderType === 'assistant' ? '🐋' : '你'
      const body = document.createElement('div'); body.className = 'ai-chat-message-body'
      const meta = document.createElement('div'); meta.className = 'ai-chat-message-meta'
      const name = document.createElement('strong'); name.textContent = message.senderType === 'assistant' ? $('#ai-chat-title').textContent : '你'
      const time = document.createElement('time'); time.textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))
      meta.append(name, time)
      body.append(meta)
      const assistantVoice = message.senderType === 'assistant' && message.audio
      if (message.content && !assistantVoice) { const content = document.createElement('p'); appendTextWithLinks(content, message.content); if (message.status === 'pending') content.classList.add('is-pending'); body.append(content) }
      if (message.audio) {
        const player = window.EchoVoicePlayer?.create({
          durationMs: message.audio.durationMs || 0,
          loadAudio: async () => { const blob = await api.getAiDirectAudioBlob(activeAgentId, message.id); const url = URL.createObjectURL(blob); audioObjectUrls.push(url); return url },
          transcript: assistantVoice ? message.content : '',
        })
        if (player) body.append(player)
      }
      if (message.botSticker) { const image = document.createElement('img'); image.className = 'ai-chat-sticker'; image.alt = message.botSticker.name || '机器人表情包'; image.loading = 'lazy'; body.append(image); const load = message.botSticker.mockDataUrl ? Promise.resolve(message.botSticker.mockDataUrl) : api.getAiStickerBlob(message.botSticker.id).then((blob) => URL.createObjectURL(blob)); load.then((url) => { if (image.isConnected) image.src = url }).catch(() => { image.alt = '表情包加载失败' }) }
      row.append(avatar, body); list.append(row)
    }
    list.scrollTop = list.scrollHeight
  }

  async function loadAgents() {
    const servers = await api.getServers()
    const serverId = servers[0]?.id
    if (!serverId) return
    const result = await api.getAiAgents(serverId)
    agents = result.agents || []
    const list = $('#ai-agent-list'); list.replaceChildren()
    for (const agent of agents.filter((item) => item.enabled)) {
      const button = document.createElement('button'); button.className = 'ai-nav-agent'; button.type = 'button'; button.dataset.agentId = agent.id
      const avatar = document.createElement('span'); avatar.className = 'ai-nav-avatar'; avatar.innerHTML = '<svg class="icon"><use href="#i-sparkles"></use></svg>'
      const name = document.createElement('span'); name.className = 'ai-nav-name'; name.textContent = agent.name
      const status = document.createElement('i'); status.className = `ai-nav-status${agent.enabled ? ' enabled' : ''}`
      button.append(avatar, name, status); button.title = agent.enabled ? `私聊 ${agent.name}` : `${agent.name} 当前已停用`
      button.addEventListener('click', () => openChat(agent.id)); list.append(button)
    }
  }

  async function refreshConversation() {
    if (!activeAgentId) return
    const result = await api.getAiConversation(activeAgentId)
    conversationId = result.conversation.id
    $('#ai-chat-title').textContent = result.agent.name
    renderMessages(result.messages || [])
  }

  async function openChat(agentId) {
    activeAgentId = agentId; conversationId = null
    const agent = agents.find((item) => item.id === agentId)
    $('#ai-chat-title').textContent = agent?.name || 'AI 伙伴'
    $('#ai-chat-overlay').hidden = false
    document.body.classList.add('ai-chat-open')
    try { await refreshConversation(); $('#ai-chat-input').focus() }
    catch (error) { window.EchoApp?.toast(error.message || '无法打开 AI 私聊') }
  }

  $('#ai-chat-close').addEventListener('click', () => { $('#ai-chat-overlay').hidden = true; document.body.classList.remove('ai-chat-open') })
  $('#ai-chat-overlay').addEventListener('click', (event) => { if (event.target === $('#ai-chat-overlay')) $('#ai-chat-close').click() })
  $('#ai-chat-clear').addEventListener('click', async () => {
    if (!activeAgentId || !confirm('清空这段私聊历史？此操作无法撤销。')) return
    try { await api.clearAiConversation(activeAgentId); await refreshConversation() }
    catch (error) { window.EchoApp?.toast(error.message || '清空私聊失败') }
  })
  $('#ai-chat-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = $('#ai-chat-input'); const content = input.value.trim()
    if (!content || !activeAgentId || busy) return
    busy = true; $('#ai-chat-send').disabled = true; input.disabled = true
    const typing = document.createElement('div'); typing.className = 'ai-chat-typing'; typing.textContent = `${$('#ai-chat-title').textContent} 正在输入…`; $('#ai-chat-messages').append(typing)
    try { await api.sendAiDirectMessage(activeAgentId, content); input.value = ''; await refreshConversation() }
    catch (error) { await refreshConversation().catch(() => {}); window.EchoApp?.toast(error.message || '消息发送失败') }
    finally { busy = false; $('#ai-chat-send').disabled = false; input.disabled = false; input.focus() }
  })
  $('#ai-chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#ai-chat-form').requestSubmit() } })
  $('#open-ai-settings').addEventListener('click', () => { $('#audio-settings').hidden = false; $('#settings-ai-tab').click() })
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#ai-chat-overlay').hidden) $('#ai-chat-close').click() })
  api.subscribe('ai.direct.message.created', (event) => { if (event.conversationId === conversationId && !busy) refreshConversation().catch(() => {}) })
  api.subscribe('ai.direct.reply.failed', (event) => { if (event.conversationId === conversationId) window.EchoApp?.toast(event.reason || 'AI 暂时无法回复') })
  api.subscribe('ai.direct.voice.failed', (event) => { if (event.conversationId === conversationId) window.EchoApp?.toast(event.reason || '语音生成失败，已发送文字回复') })
  window.addEventListener('echo:authenticated', () => { agents = []; loadAgents().catch(() => {}) })
  window.addEventListener('echo:ai-agents-updated', () => loadAgents().catch(() => {}))
  window.EchoAiChatReady = window.EchoAppReady.then(loadAgents)
})()
