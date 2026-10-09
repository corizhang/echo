(() => {
  const api = window.EchoApi
  const $ = (selector, root = document) => root.querySelector(selector)
  const icon = (name, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`
  const state = { user: null, servers: [], channels: [], members: [], serverId: null, channelId: null, voiceChannelId: null, gameRoomId: null, joined: false, muted: false, deafened: false, search: '', replyTo: null, pinsOpen: false }

  function toast(message) {
    const region = $('#toast-region')
    const item = document.createElement('div'); item.className = 'toast'; item.textContent = message; region.append(item)
    setTimeout(() => item.remove(), 2800)
  }
  function formatTime(value) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  }
  function makeAvatar(label, color, size = '') {
    const avatar = document.createElement('div'); avatar.className = `avatar ${color || 'blue'} ${size}`.trim(); avatar.textContent = label || '?'; return avatar
  }
  function currentChannel() { return state.channels.find((channel) => channel.id === state.channelId) }

  async function renderChannels() {
    const channels = await api.getChannels(state.serverId); state.channels = channels
    const textList = $('#text-channels'); const voiceList = $('#voice-channels'); textList.replaceChildren(); voiceList.replaceChildren()
    channels.filter((channel) => channel.type === 'text').forEach((channel) => {
      const button = document.createElement('button'); button.className = `channel-row${channel.id === state.channelId ? ' selected' : ''}`; button.dataset.channelId = channel.id
      button.innerHTML = `${icon('hash')}<span class="channel-name"></span>${channel.unread && channel.id !== state.channelId ? '<i class="unread-dot"></i>' : ''}`; $('.channel-name', button).textContent = channel.name
      button.addEventListener('click', () => selectChannel(channel.id)); textList.append(button)
    })
    channels.filter((channel) => channel.type === 'voice').forEach((channel) => {
      const button = document.createElement('button'); button.className = `channel-row voice-row${channel.id === state.voiceChannelId && state.joined ? ' voice-selected' : ''}`
      button.innerHTML = `${icon('volume')}<span class="channel-name"></span><span class="voice-count">${state.joined && channel.id === state.voiceChannelId ? '已连接' : ''}</span>`; $('.channel-name', button).textContent = channel.name
      button.addEventListener('click', async () => {
        if (voiceBusy) return
        if (state.joined && state.voiceChannelId === channel.id) return
        try { if (state.joined) await disconnectVoice(); state.voiceChannelId = channel.id; await connectVoice() } catch (error) { toast(error.message) }
      }); voiceList.append(button)
      if (state.joined && channel.id === state.voiceChannelId) {
        const self = document.createElement('div'); self.className = 'voice-people'; self.innerHTML = '<div class="mini-avatar blue"></div><span></span>'
        self.firstElementChild.textContent = state.user.displayName.slice(0,1); self.lastElementChild.textContent = `${state.user.displayName} · 你`; voiceList.append(self)
      }
    })
  }

  async function renderMembers() {
    const members = await api.getMembers(state.serverId); state.members = members
    const online = [...new Map([state.user, ...members].filter((member) => member.status !== 'offline').map((member) => [member.id, member])).values()]
    $('#member-count').textContent = `成员 — ${online.length}`
    $('#member-group-label').textContent = `在线 — ${online.length}`
    const list = $('#member-list'); list.replaceChildren()
    online.forEach((member) => {
      const row = document.createElement('div'); row.className = 'member-row'; row.tabIndex = 0
      row.append(makeAvatar(member.avatar, member.color))
      const detail = document.createElement('div'); detail.className = 'member-detail'
      const name = document.createElement('strong'); name.textContent = member.displayName; if (member.id === state.user.id) { const you = document.createElement('small'); you.textContent = '你'; name.append(' ', you) }
      const activity = document.createElement('span'); activity.textContent = member.id === state.user.id && state.joined ? `在语音 · ${state.channels.find((channel) => channel.id === state.voiceChannelId)?.name || ''}` : member.activity || '在线'
      detail.append(name, activity); row.append(detail)
      if (member.id === 'user-mori') { const game = document.createElement('span'); game.className = 'activity-icon'; game.innerHTML = icon('game'); row.append(game) }
      row.addEventListener('click', () => toast(`打开 ${member.displayName} 的个人资料`)); list.append(row)
    })
  }

  async function renderMessages() {
    const channel = currentChannel(); if (!channel) return
    const messages = await api.getMessages(channel.id); const target = $('#messages'); target.replaceChildren()
    $('#room-title').textContent = channel.name; $('#room-topic').textContent = channel.topic || '和朋友一起聊天'; $('#welcome-title').textContent = `欢迎来到 #${channel.name}！`; $('#welcome-topic').textContent = `这里是 #${channel.name} 的开始。`; $('#message-input').placeholder = `发送消息到 #${channel.name}`
    const filtered = messages.filter((message) => !state.search || message.content.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()) || message.author.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()))
    if (!filtered.length && state.search) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = '没有找到匹配的消息。'; target.append(empty) }
    filtered.forEach((message) => {
      const article = document.createElement('article'); article.className = 'message'; article.dataset.messageId = message.id
      article.append(makeAvatar(message.avatar, message.color, 'message-avatar'))
      const body = document.createElement('div'); body.className = 'message-body'
      const meta = document.createElement('div'); meta.className = 'message-meta'; const author = document.createElement('strong'); author.textContent = message.author
      if (message.authorId === state.user.id) { const badge = document.createElement('span'); badge.className = 'self-badge'; badge.textContent = '你'; author.append(' ', badge) }
      const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = formatTime(message.createdAt); meta.append(author, time)
      if (message.pinned) { const pin = document.createElement('span'); pin.className = 'pinned-label'; pin.innerHTML = `${icon('pin', 'icon tiny')} 已置顶`; meta.append(pin) }
      body.append(meta)
      if (message.replyTo) { const reply = document.createElement('div'); reply.className = 'reply-context'; reply.textContent = `回复 ${message.replyTo.author}：${message.replyTo.content}`; body.append(reply) }
      const content = document.createElement('p'); content.textContent = message.content; body.append(content)
      if (message.reactions?.length) { const reactions = document.createElement('div'); reactions.className = 'reaction-list'; message.reactions.forEach((reaction) => { const button = document.createElement('button'); button.className = `reaction${reaction.reacted ? ' reacted' : ''}`; button.innerHTML = `<span></span><b></b>`; $('span', button).textContent = reaction.emoji; $('b', button).textContent = reaction.count; button.title = '添加或取消反应'; button.addEventListener('click', () => mutate(() => api.toggleReaction(message.id, reaction.emoji))); reactions.append(button) }); body.append(reactions) }
      article.append(body)
      const actions = document.createElement('div'); actions.className = 'message-actions'
      actions.append(actionButton('smile-plus', '添加反应', () => openEmojiPicker(message.id)), actionButton('reply', '回复', () => setReply(message)), actionButton('pin', message.pinned ? '取消置顶' : '置顶消息', () => mutate(() => api.togglePin(message.id))))
      article.append(actions); target.append(article)
    })
  }

  function actionButton(iconName, label, handler) { const button = document.createElement('button'); button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = icon(iconName); button.addEventListener('click', handler); return button }
  async function renderPins() {
    const all = await api.getMessages(state.channelId); const pins = all.filter((message) => message.pinned); const target = $('#pins-list'); target.replaceChildren()
    if (!pins.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '这里还没有置顶消息。'; target.append(empty); return }
    pins.forEach((message) => { const card = document.createElement('article'); card.className = 'pin-card'; const title = document.createElement('strong'); title.textContent = message.author; const text = document.createElement('p'); text.textContent = message.content; const date = document.createElement('time'); date.textContent = formatTime(message.createdAt); card.append(title, date, text); target.append(card) })
  }
  async function mutate(action) { await action(); await renderMessages(); if (state.pinsOpen) renderPins() }
  async function selectServer(id) { if (state.joined) { state.joined = false; $('#voice-connected').hidden = true; $('#join-button').textContent = '加入语音' } state.serverId = id; state.channels = await api.getChannels(id); state.channelId = state.channels.find((channel) => channel.type === 'text')?.id; state.voiceChannelId = state.channels.find((channel) => channel.type === 'voice')?.id; await renderChannels(); await renderMessages(); await renderMembers() }
  async function selectChannel(id) { document.querySelector('.app-shell').classList.remove('room-view'); document.querySelector('#game-pane').hidden = true; window.dispatchEvent(new Event('echo:chat-view')); state.channelId = id; state.search = ''; $('#search-input').value = ''; await renderChannels(); await renderMessages() }
  function setReply(message) { state.replyTo = message; const preview = $('#reply-preview'); preview.hidden = false; preview.replaceChildren(); const label = document.createElement('span'); label.textContent = `回复 ${message.author}：${message.content}`; const close = actionButton('more', '取消回复', () => { state.replyTo = null; preview.hidden = true }); preview.append(label, close); $('#message-input').focus() }

  async function connectVoice() {
    if (voiceBusy) return
    if (!state.voiceChannelId) state.voiceChannelId = state.channels.find(channel => channel.type === 'voice')?.id
    if (!state.voiceChannelId) { toast('小队还没有语音频道'); return }
    voiceBusy = true
    const button = $('#join-button'); let preparedAudioTrack
    button.disabled = true; button.textContent = '连接中…'
    try {
      let ticket
      if (api.mode === 'http') {
        await window.EchoVoiceReady
        preparedAudioTrack = await window.EchoVoice.prepareMicrophone(window.EchoAudio?.getInputDeviceId() || 'default')
        ticket = await api.getVoiceToken(state.voiceChannelId)
        await window.EchoVoice.connect(ticket, preparedAudioTrack)
        await window.EchoVoice.setMuted(state.muted); window.EchoVoice.setDeafened(state.deafened)
      } else ticket = await api.getVoiceToken(state.voiceChannelId)
      await api.setVoicePresence(state.voiceChannelId, true); state.joined = true
      $('#voice-connected').hidden = false; $('#connected-channel').textContent = `${state.channels.find((channel) => channel.id === state.voiceChannelId)?.name} · ${api.mode === 'mock' ? '演示模式' : '实时语音'}`
      $('#join-button').textContent = '离开语音'; await renderChannels(); await renderMembers()
      toast(api.mode === 'mock' ? `已模拟连接语音房间 ${ticket.room}` : `已连接语音房间 ${ticket.room}`)
    } catch (error) { preparedAudioTrack?.stop(); toast(error.message || '暂时无法加入语音') }
    finally { voiceBusy = false; button.disabled = false; button.textContent = state.joined ? '离开语音' : '加入语音'; window.dispatchEvent(new Event('echo:voice-state')) }
  }
  let voiceBusy = false
  function voiceState() { return { joined: state.joined, roomId: state.gameRoomId, channelId: state.voiceChannelId, busy: voiceBusy } }
  function adoptGameVoice(room) {
    if (state.joined && state.voiceChannelId === room.voiceRoomId) {
      state.gameRoomId = room.id
      $('#connected-channel').textContent = `${room.title} · 语音大厅`
      window.dispatchEvent(new Event('echo:voice-state'))
    }
  }
  async function joinGameVoice(room) {
    if (voiceBusy) throw new Error('语音正在连接，请稍候')
    if (state.joined && (state.gameRoomId === room.id || state.voiceChannelId === room.voiceRoomId)) { adoptGameVoice(room); return }
    voiceBusy = true
    let preparedAudioTrack
    try {
      if (state.joined) await disconnectVoice()
      if (api.mode === 'http') {
        await window.EchoVoiceReady
        preparedAudioTrack = await window.EchoVoice.prepareMicrophone(window.EchoAudio?.getInputDeviceId() || 'default')
        await window.EchoVoice.connect(await api.getGameVoiceToken(room.id), preparedAudioTrack)
        await window.EchoVoice.setMuted(state.muted); window.EchoVoice.setDeafened(state.deafened)
      }
      state.joined = true; state.gameRoomId = room.id; state.voiceChannelId = null
      $('#voice-connected').hidden = false; $('#connected-channel').textContent = `${room.title} · ${api.mode === 'mock' ? '语音演示' : '房间语音'}`
      $('#join-button').textContent = '离开语音'
      await renderChannels()
    } catch (error) { preparedAudioTrack?.stop(); throw error }
    finally { voiceBusy = false; window.dispatchEvent(new Event('echo:voice-state')) }
  }
  async function disconnectVoice() {
    const channelId = state.voiceChannelId
    if (api.mode === 'http') await window.EchoVoice?.disconnect()
    state.joined = false; state.gameRoomId = null; state.voiceChannelId = null
    $('#voice-connected').hidden = true; $('#join-button').textContent = '加入语音'
    window.dispatchEvent(new Event('echo:voice-state'))
    if (channelId) await api.setVoicePresence(channelId, false)
    await renderChannels(); await renderMembers()
  }
  window.addEventListener('echo:voice-disconnected', () => {
    state.joined = false; state.gameRoomId = null; state.voiceChannelId = null
    $('#voice-connected').hidden = true; $('#join-button').textContent = '加入语音'
    window.dispatchEvent(new Event('echo:voice-state'))
    if (state.serverId) renderChannels().catch(console.error)
  })
  window.EchoApp = { joinGameVoice, adoptGameVoice, disconnectVoice, voiceState, isGameRoomVoice: (id) => state.gameRoomId === id,
    showGame() { document.querySelector('.app-shell').classList.add('room-view'); $('#game-pane').hidden = false; $('#pins-panel').hidden = true; state.pinsOpen = false; $('#emoji-popover').hidden = true },
    getSquadId: () => state.serverId,
    getUser: () => state.user,
    toast,
  }
  function openEmojiPicker(messageId) {
    const popover = $('#emoji-popover'); popover.replaceChildren(); ['👍', '❤️', '😂', '🎮', '🔥', '🙌', '🎉', '👀'].forEach((emoji) => { const button = document.createElement('button'); button.textContent = emoji; button.title = `反应 ${emoji}`; button.addEventListener('click', async () => { await api.toggleReaction(messageId, emoji); popover.hidden = true; renderMessages() }); popover.append(button) }); popover.hidden = false
  }

  $('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const input = $('#message-input'); const content = input.value.trim(); if (!content) return
    try { await api.sendMessage(state.channelId, { content, replyTo: state.replyTo ? { id: state.replyTo.id, author: state.replyTo.author, content: state.replyTo.content } : null }); input.value = ''; input.style.height = 'auto'; state.replyTo = null; $('#reply-preview').hidden = true; await renderMessages(); $('#message-scroll').scrollTop = $('#message-scroll').scrollHeight }
    catch (error) { toast(error.message || '发送失败') }
  })
  $('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#message-form').requestSubmit() } })
  $('#message-input').addEventListener('input', (event) => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 140)}px` })
  $('#search-input').addEventListener('input', async (event) => { state.search = event.currentTarget.value.trim(); await renderMessages() })
  document.addEventListener('keydown', (event) => { if (event.target.closest('[role=dialog],dialog[open]')) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus() } else if (event.key === 'Escape') { $('#emoji-popover').hidden = true; $('#search-input').blur() } })
  $('#toggle-members').addEventListener('click', () => { const sidebar = $('#member-sidebar'); sidebar.classList.toggle('hidden'); $('#toggle-members').classList.toggle('action-active', !sidebar.classList.contains('hidden')) })
  $('#pins-button').addEventListener('click', async () => { state.pinsOpen = !state.pinsOpen; $('#pins-panel').hidden = !state.pinsOpen; if (state.pinsOpen) await renderPins() })
  $('#close-pins').addEventListener('click', () => { state.pinsOpen = false; $('#pins-panel').hidden = true })
  $('#join-button').addEventListener('click', () => state.joined ? disconnectVoice() : connectVoice())
  $('#leave-voice').addEventListener('click', disconnectVoice)
  $('#mute-button').addEventListener('click', async (event) => { state.muted = !state.muted; try { if (api.mode === 'http' && state.joined) await window.EchoVoice.setMuted(state.muted); event.currentTarget.innerHTML = icon(state.muted ? 'mic-off' : 'mic'); event.currentTarget.classList.toggle('action-active', state.muted); event.currentTarget.title = state.muted ? '取消静音' : '静音'; toast(state.muted ? `麦克风已静音${api.mode === 'mock' ? '（演示）' : ''}` : `麦克风已开启${api.mode === 'mock' ? '（演示）' : ''}`) } catch (error) { state.muted = !state.muted; toast(error.message || '麦克风状态更新失败') } })
  $('#deafen-button').addEventListener('click', async (event) => { state.deafened = !state.deafened; if (api.mode === 'http' && state.joined) window.EchoVoice.setDeafened(state.deafened); event.currentTarget.innerHTML = icon(state.deafened ? 'headphones-off' : 'headphones'); event.currentTarget.classList.toggle('action-active', state.deafened); event.currentTarget.title = state.deafened ? '取消耳机静音' : '耳机静音' })
  $('#emoji-button').addEventListener('click', () => { const popover = $('#emoji-popover'); popover.replaceChildren(); ['😀', '😂', '🥹', '👍', '❤️', '🎮', '🔥', '🙌'].forEach((emoji) => { const button = document.createElement('button'); button.textContent = emoji; button.addEventListener('click', () => { $('#message-input').value += emoji; $('#message-input').focus(); popover.hidden = true }); popover.append(button) }); popover.hidden = false })
  $('#invite-button').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('邀请链接已复制') } catch { toast('邀请链接：' + location.href) } })
  $('.composer-plus').addEventListener('click', () => toast('附件上传接口已预留'))
  $('.header-actions button[title="通知"]').addEventListener('click', () => toast('暂无新通知'))
  document.addEventListener('click', (event) => { if (!event.target.closest('#emoji-popover') && !event.target.closest('#emoji-button') && !event.target.closest('.message-actions')) $('#emoji-popover').hidden = true })
  document.querySelectorAll('.create-channel').forEach((button) => button.addEventListener('click', async () => { const name = window.prompt(button.dataset.type === 'voice' ? '新语音频道名称' : '新文字频道名称'); if (!name?.trim()) return; try { const channel = await api.createChannel(state.serverId, { name, type: button.dataset.type }); if (channel.type === 'text') state.channelId = channel.id; else state.voiceChannelId = channel.id; await renderChannels(); if (channel.type === 'text') renderMessages(); toast(api.mode === 'mock' ? '频道已创建（mock）' : '频道已创建') } catch (error) { toast(error.message || '创建频道失败') } }))
  api.subscribe('message.created', (message) => { if (message.channelId === state.channelId) renderMessages() })
  api.subscribe('message.updated', (message) => { if (message.channelId === state.channelId) renderMessages() })
  api.subscribe('channel.created', () => renderChannels())

  async function start() {
    await window.EchoAuthReady
    state.user = await api.getMe(); state.servers = await api.getServers(); state.serverId = state.servers[0]?.id
    await selectServer(state.serverId)
    $('.profile-copy strong').textContent = state.user.displayName
    const avatar = $('.profile-avatar'); avatar.textContent = state.user.avatar || state.user.displayName.slice(0, 1); avatar.className = `avatar ${state.user.color || 'blue'} profile-avatar`; const presence = document.createElement('span'); presence.className = 'presence'; avatar.append(presence)
    document.querySelectorAll('.settings-nav-footer .avatar').forEach((item) => { item.textContent = state.user.avatar || state.user.displayName.slice(0, 1); item.className = `avatar ${state.user.color || 'blue'}` })
    document.querySelectorAll('.settings-nav-footer strong').forEach((item) => { item.textContent = state.user.displayName })
  }
  window.EchoAppReady = start().catch((error) => { console.error(error); toast('初始化失败，请刷新页面'); throw error })
})()
