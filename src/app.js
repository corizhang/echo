(() => {
  const api = window.EchoApi
  const $ = (selector, root = document) => root.querySelector(selector)
  const icon = (name, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`
  const MAX_VOICE_MESSAGE_DURATION_MS = 120_000
  const attachmentObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => entries.forEach((entry) => { if (!entry.isIntersecting) return; attachmentObserver.unobserve(entry.target); loadAttachmentImage(entry.target) }), { root: $('#message-scroll'), rootMargin: '220px' }) : null
  const state = { user: null, servers: [], channels: [], members: [], expressions: { emojis: [], stickers: [], groups: { emoji: [], sticker: [] }, canManageSystem: false }, expressionTab: 'emoji', expressionScope: 'personal', expressionQuery: '', expressionGroupId: { emoji: '', sticker: '' }, serverId: null, channelId: null, voiceChannelId: null, gameRoomId: null, joined: false, muted: false, deafened: false, search: '', searchFilters: { scope: 'channel', authorId: '', fromDate: '', toDate: '', hasImage: false }, replyTo: null, pinsOpen: false, mentions: [], mentionQuery: null, mentionIndex: 0, inputBeforeEdit: null, pendingAttachments: [], pendingAudio: null, sendingMessage: false, editingMessageId: null, messageItems: [], messageHeights: new Map(), messageMeasureWidth: 0, renderWindow: null, virtualRenderScheduled: false, hasMoreMessages: false, hasNewerMessages: false, loadingOlder: false, loadingNewer: false, newMessages: 0, unreadStartId: null, searchTimer: null, messageRequestVersion: 0, atBottom: true }
  let voiceRecorder = null; let voiceStream = null; let voiceChunks = []; let voiceTimer = null; let voiceStartedAt = 0; let voiceOriginChannelId = null; let voiceDiscardOnStop = false; let voiceAudioContext = null; let voiceAnimationFrame = 0
  const attachmentUrlCache = new Map()
  const expressionUrlCache = new Map()
  const EMOJI_GROUPS = [
    { name: '常用', terms: '常用 最近', items: ['😀','😃','😄','😁','😆','😅','😂','🤣','😋','😊','😍','😘','😎','🤔','😴','😭','😡','🤯','🥳','🤩','😏','🙃','🤗','😇'] },
    { name: '手势', terms: '手势 点赞', items: ['👍','👎','👏','🙌','🤝','🙏','👌','✌️','🤞','🤟','💪','👋','💐','👀','🤦','🤷'] },
    { name: '游戏', terms: '游戏 开黑 魔兽', items: ['🎮','🕹️','🏆','⚔️','🛡️','🧙','🧝','🐉','💀','🧟','🪄','🎲','🃏','🚀','🔥','💥'] },
    { name: '爱心', terms: '爱心 喜欢', items: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕','💖','💯','✨','⭐','🌟','🎉'] },
    { name: '动物与其他', terms: '动物 食物 其他', items: ['🐱','🐶','🐼','🐸','🐳','🦈','🦄','🐔','🍕','🍜','🍺','☕','🌈','☀️','🌙','💤'] },
  ]
  const EMOJI_KEYWORDS = { '😀':'笑 开心 高兴', '😃':'笑 开心 高兴', '😄':'笑 开心 大笑', '😁':'笑 开心 露齿', '😆':'笑 大笑', '😅':'笑 尴尬 汗', '😂':'笑 哭 笑哭', '🤣':'笑 滚地', '😋':'美味 调皮', '😊':'微笑 开心', '😍':'爱心 喜欢 花痴', '😘':'亲亲 飞吻', '😎':'酷 墨镜', '🤔':'思考 疑问', '😴':'睡觉 困', '😭':'哭 伤心', '😡':'生气 愤怒', '🤯':'震惊 爆炸', '🥳':'庆祝 派对', '🤩':'崇拜 星星', '😏':'坏笑 得意', '🙃':'无语 反转', '🤗':'拥抱', '😇':'天使', '👍':'赞 同意', '👎':'踩 反对', '👏':'鼓掌', '🙌':'欢呼', '🤝':'握手', '🙏':'祈祷 感谢', '👌':'好的', '✌️':'胜利', '🤞':'祈祷 好运', '🤟':'摇滚', '💪':'加油 力量', '👋':'挥手 再见', '👀':'围观 看', '🤦':'捂脸', '🤷':'耸肩'}

  function toast(message) {
    const region = $('#toast-region')
    const item = document.createElement('div'); item.className = 'toast'; item.textContent = message; region.append(item)
    setTimeout(() => item.remove(), 2800)
  }
  function formatTime(value) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  }
  function dateKey(value) { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` }
  function formatDateDivider(value) {
    const date = new Date(value); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
    if (dateKey(date) === dateKey(today)) return '今天'
    if (dateKey(date) === dateKey(yesterday)) return '昨天'
    return new Intl.DateTimeFormat('zh-CN', { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(date)
  }
  function fullDateTime(value) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) }
  function isSearching() { const filters = state.searchFilters; return Boolean(state.search || filters.authorId || filters.fromDate || filters.toDate || filters.hasImage) }
  function searchOptions(extra = {}) { return { query: state.search, authorId: state.searchFilters.authorId, fromDate: state.searchFilters.fromDate, toDate: state.searchFilters.toDate, hasImage: state.searchFilters.hasImage, limit: 50, ...extra } }
  function isNearBottom(element = $('#message-scroll')) { return element.scrollHeight - element.scrollTop - element.clientHeight < 72 }
  function currentMessageAnchor() {
    const scroller = $('#message-scroll'); const top = scroller.getBoundingClientRect().top
    const message = [...$('#messages').querySelectorAll('.message')].find((item) => item.getBoundingClientRect().bottom > top)
    return message ? { id: message.dataset.messageId, top: message.getBoundingClientRect().top } : null
  }
  const VIRTUAL_MESSAGE_THRESHOLD = 140
  function messageVirtualRange(messages, scroller, target, { scrollToBottom = false, scrollToTop = false, anchor = null } = {}) {
    const count = messages.length
    if (count <= VIRTUAL_MESSAGE_THRESHOLD) return { start: 0, end: count, heights: null }
    const heights = new Array(count); const prefix = new Array(count + 1); prefix[0] = 0
    let previousDate = null
    messages.forEach((message, index) => {
      const currentDate = dateKey(message.createdAt)
      const separator = currentDate !== previousDate ? 42 : 0
      const contentEstimate = Math.ceil((message.content || '').length / Math.max(45, Math.floor(target.clientWidth / 8))) * 21
      const estimate = 46 + contentEstimate + (message.replyTo ? 22 : 0) + (message.attachments?.length ? Math.min(280, message.attachments.length * 190) : 0) + (message.sticker || message.botSticker ? 210 : 0) + (message.reactions?.length ? 28 : 0)
      heights[index] = (state.messageHeights.get(message.id) || estimate) + separator
      prefix[index + 1] = prefix[index] + heights[index]
      previousDate = currentDate
    })
    const viewportHeight = Math.max(320, scroller.clientHeight)
    const listTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    let visibleTop = scrollToBottom ? prefix[count] - viewportHeight : scrollToTop ? 0 : scroller.scrollTop - listTop
    if (anchor?.id) {
      const anchorIndex = messages.findIndex((message) => message.id === anchor.id)
      if (anchorIndex >= 0) visibleTop = prefix[anchorIndex] - (anchor.top - scroller.getBoundingClientRect().top)
    }
    const windowTop = Math.max(0, visibleTop - viewportHeight * 1.5)
    const windowBottom = Math.min(prefix[count], visibleTop + viewportHeight * 2.5)
    let start = 0; while (start < count && prefix[start + 1] < windowTop) start++
    let end = start; while (end < count && prefix[end] <= windowBottom) end++
    if (end - start < 30) end = Math.min(count, start + 30)
    return { start, end, heights, prefix }
  }
  function scheduleVirtualRender() {
    if (state.messageItems.length <= VIRTUAL_MESSAGE_THRESHOLD || state.virtualRenderScheduled || (state.atBottom && state.renderWindow?.end === state.messageItems.length)) return
    const scroller = $('#message-scroll'); const target = $('#messages'); const first = target.querySelector('.message'); const last = target.querySelector('.message:last-of-type')
    if (!first || !last) return
    const viewport = scroller.getBoundingClientRect(); const firstRect = first.getBoundingClientRect(); const lastRect = last.getBoundingClientRect()
    const nearStart = state.renderWindow?.start > 0 && firstRect.top > viewport.top - scroller.clientHeight
    const nearEnd = state.renderWindow?.end < state.messageItems.length && lastRect.bottom < viewport.bottom + scroller.clientHeight
    if (!nearStart && !nearEnd) return
    state.virtualRenderScheduled = true
    requestAnimationFrame(() => {
      state.virtualRenderScheduled = false
      if (state.messageItems.length <= VIRTUAL_MESSAGE_THRESHOLD) return
      const range = messageVirtualRange(state.messageItems, scroller, target)
      if (!state.renderWindow || range.start !== state.renderWindow.start || range.end !== state.renderWindow.end) renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() })
    })
  }
  function makeAvatar(label, color, size = '') {
    const avatar = document.createElement('div'); avatar.className = `avatar ${color || 'blue'} ${size}`.trim(); avatar.textContent = label || '?'; return avatar
  }
  function currentChannel() { return state.channels.find((channel) => channel.id === state.channelId) }
  function loadAttachmentImage(image) {
    if (image.dataset.loading === 'true' || image.dataset.loaded === 'true') return
    image.dataset.loading = 'true'
    getAttachmentUrl(image.echoAttachment).then((url) => { if (image.isConnected) { image.src = url; image.dataset.loaded = 'true' } }).catch(() => { const caption = image.closest('.message-attachment')?.querySelector('.message-attachment-caption'); if (caption?.isConnected) caption.textContent = '图片加载失败或你没有访问权限' })
  }
  function appendTextWithLinks(target, text) {
    const value = String(text)
    const pattern = /https?:\/\/[^\s<>"']+/giu
    let offset = 0
    for (const match of value.matchAll(pattern)) {
      target.append(document.createTextNode(value.slice(offset, match.index)))
      let raw = match[0]
      const trailing = raw.match(/[).,!?;:，。！？、】）]+$/u)?.[0] || ''
      if (trailing) raw = raw.slice(0, -trailing.length)
      try {
        const url = new URL(raw)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link protocol')
        const link = document.createElement('a'); link.href = url.toString(); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'message-link'; link.textContent = raw; target.append(link)
      } catch { target.append(document.createTextNode(raw)) }
      if (trailing) target.append(document.createTextNode(trailing))
      offset = match.index + match[0].length
    }
    target.append(document.createTextNode(value.slice(offset)))
  }

  function renderMessageContent(target, message) {
    const content = String(message.content || '')
    const mentions = (Array.isArray(message.mentions) ? message.mentions : []).filter((item) => Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end <= content.length && item.end > item.start && content.slice(item.start, item.end).startsWith('@')).sort((a, b) => a.start - b.start)
    let offset = 0
    for (const mention of mentions) {
      if (mention.start < offset) continue
      appendTextWithLinks(target, content.slice(offset, mention.start))
      const label = content.slice(mention.start, mention.end)
      const tag = document.createElement('span'); tag.className = 'message-mention'; tag.dataset.userId = mention.userId; tag.textContent = label; target.append(tag)
      offset = mention.end
    }
    appendTextWithLinks(target, content.slice(offset))
  }

  async function getAttachmentUrl(attachment) {
    if (attachment.mockDataUrl) return attachment.mockDataUrl
    if (!attachmentUrlCache.has(attachment.id)) {
      attachmentUrlCache.set(attachment.id, api.getAttachmentBlob(attachment.id).then((blob) => URL.createObjectURL(blob)).catch((error) => { attachmentUrlCache.delete(attachment.id); throw error }))
    }
    return attachmentUrlCache.get(attachment.id)
  }

  async function getExpressionUrl(expression) {
    if (expression.mockDataUrl) return expression.mockDataUrl
    if (!expressionUrlCache.has(expression.id)) expressionUrlCache.set(expression.id, api.getExpressionBlob(expression.id).then((blob) => URL.createObjectURL(blob)).catch((error) => { expressionUrlCache.delete(expression.id); throw error }))
    return expressionUrlCache.get(expression.id)
  }
  async function getBotStickerUrl(sticker) {
    if (sticker.mockDataUrl) return sticker.mockDataUrl
    if (!expressionUrlCache.has(`bot:${sticker.id}`)) expressionUrlCache.set(`bot:${sticker.id}`, api.getAiStickerBlob(sticker.id).then((blob) => URL.createObjectURL(blob)).catch((error) => { expressionUrlCache.delete(`bot:${sticker.id}`); throw error }))
    return expressionUrlCache.get(`bot:${sticker.id}`)
  }
  function loadExpressionImage(image) { const expression = image.echoExpression || { id: image.dataset.expressionId }; if (!expression.id || image.dataset.loading === 'true') return; image.dataset.loading = 'true'; const load = expression.isBotSticker ? getBotStickerUrl(expression) : getExpressionUrl(expression); load.then((url) => { if (image.isConnected) image.src = url }).catch(() => { if (image.isConnected) image.alt = '表情加载失败' }) }
  function renderMessageSticker(target, sticker) {
    if (!sticker) return
    const card = document.createElement('div'); card.className = 'message-sticker-card'
    const image = document.createElement('img'); image.className = 'message-sticker'; image.alt = sticker.name || '表情包'; image.loading = 'lazy'; image.echoExpression = sticker; image.addEventListener('click', () => openStickerPreview(sticker)); loadExpressionImage(image)
    card.append(image); target.append(card)
  }
  function openStickerPreview(sticker) {
    const overlay = document.createElement('div'); overlay.className = 'sticker-preview-overlay'; overlay.addEventListener('click', () => overlay.remove())
    const image = document.createElement('img'); image.alt = sticker.name || '表情包'; image.echoExpression = sticker; loadExpressionImage(image)
    const caption = document.createElement('span'); caption.textContent = sticker.name || '表情包'; overlay.append(image, caption); document.body.append(overlay)
  }

  function renderMessageAttachments(target, attachments = [], transcript = '') {
    if (!attachments.length) return
    const gallery = document.createElement('div'); gallery.className = 'message-attachments'
    for (const attachment of attachments) {
      if (String(attachment.mimeType || '').startsWith('audio/')) {
        const player = window.EchoVoicePlayer?.create({ durationMs: attachment.durationMs || 0, loadAudio: () => getAttachmentUrl(attachment), transcript })
        if (player) gallery.append(player)
        continue
      }
      const card = document.createElement('div'); card.className = 'message-attachment'
      const image = document.createElement('img'); image.alt = attachment.fileName || '聊天图片'; image.loading = 'lazy'; image.decoding = 'async'
      image.echoAttachment = attachment
      const caption = document.createElement('div'); caption.className = 'message-attachment-caption'; caption.textContent = `${attachment.fileName || '图片'}${attachment.sizeBytes ? ` · ${(attachment.sizeBytes / 1024).toFixed(0)} KB` : ''}`
      card.append(image, caption); gallery.append(card)
      if (attachmentObserver) attachmentObserver.observe(image); else loadAttachmentImage(image)
    }
    target.append(gallery)
  }

  function formatVoiceDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  function renderPendingAttachments() {
    const target = $('#attachment-drafts'); target.replaceChildren(); target.hidden = !state.pendingAttachments.length && !state.pendingAudio
    state.pendingAttachments.forEach((item, index) => {
      const card = document.createElement('div'); card.className = 'attachment-draft'; card.title = item.file.name
      const image = document.createElement('img'); image.src = item.previewUrl; image.alt = item.file.name
      const name = document.createElement('span'); name.className = 'attachment-draft-name'; name.textContent = item.file.name
      const remove = document.createElement('button'); remove.type = 'button'; remove.title = '移除图片'; remove.setAttribute('aria-label', `移除 ${item.file.name}`); remove.innerHTML = icon('close')
      remove.disabled = state.sendingMessage
      remove.addEventListener('click', async () => {
        if (state.sendingMessage) return
        if (item.attachmentId) { try { await api.deleteAttachment(item.attachmentId) } catch (error) { toast(error.message || '移除上传图片失败'); return } }
        URL.revokeObjectURL(item.previewUrl); state.pendingAttachments.splice(index, 1); renderPendingAttachments()
      })
      card.append(image, name, remove); target.append(card)
    })
    if (state.pendingAudio) {
      const draft = document.createElement('div'); draft.className = 'voice-message-draft'
      const info = document.createElement('div'); info.className = 'voice-message-draft-info'; info.innerHTML = `${icon('mic')}<span><strong>语音消息</strong><small>${formatVoiceDuration(state.pendingAudio.durationMs)} · ${(state.pendingAudio.file.size / 1024).toFixed(0)} KB</small></span>`
      const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = state.pendingAudio.previewUrl; player.setAttribute('aria-label', '试听语音消息')
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'voice-message-remove'; remove.title = '移除录音'; remove.setAttribute('aria-label', '移除录音'); remove.innerHTML = icon('close'); remove.disabled = state.sendingMessage
      remove.addEventListener('click', async () => { if (state.sendingMessage) return; if (state.pendingAudio?.attachmentId) { try { await api.deleteAttachment(state.pendingAudio.attachmentId) } catch (error) { toast(error.message || '移除录音失败'); return } } URL.revokeObjectURL(state.pendingAudio.previewUrl); state.pendingAudio = null; $('#voice-record-button').disabled = false; $('#attachment-status').textContent = state.pendingAttachments.length ? `${state.pendingAttachments.length} 张图片待发送` : ''; renderPendingAttachments(); $('#message-input').focus() })
      draft.append(info, player, remove); target.append(draft)
    }
  }

  function clearPendingAttachments() {
    const pendingIds = [...state.pendingAttachments.map((item) => item.attachmentId), state.pendingAudio?.attachmentId].filter(Boolean)
    pendingIds.forEach((id) => api.deleteAttachment(id).catch(() => {}))
    state.pendingAttachments.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    state.pendingAttachments = []
    if (state.pendingAudio) URL.revokeObjectURL(state.pendingAudio.previewUrl)
    state.pendingAudio = null
    if (voiceRecorder) cancelVoiceRecording()
    else $('#voice-record-button').disabled = false
    renderPendingAttachments(); $('#attachment-status').textContent = ''; $('#attachment-status').classList.remove('is-error')
  }

  function buildVoiceMeter() {
    const meter = $('#voice-meter'); if (meter.childElementCount) return
    for (let index = 0; index < 34; index++) { const bar = document.createElement('span'); bar.className = 'voice-meter-bar'; meter.append(bar) }
  }
  function resetVoiceRecordingUi() {
    clearInterval(voiceTimer); voiceTimer = null; cancelAnimationFrame(voiceAnimationFrame); voiceAnimationFrame = 0
    $('#voice-recorder').hidden = true; $('#voice-recorder-title').textContent = '正在录音'; $('#voice-recorder-time').textContent = '00:00'
    $('#voice-record-button').classList.remove('is-recording'); $('#voice-record-button').title = '录制语音消息'; $('#voice-record-button').disabled = Boolean(state.pendingAudio)
    $('#voice-record-stop').disabled = false
  }
  async function releaseVoiceCapture() {
    voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null
    if (voiceAudioContext) { const context = voiceAudioContext; voiceAudioContext = null; await context.close().catch(() => {}) }
  }
  function cancelVoiceRecording() {
    if (!voiceRecorder) { resetVoiceRecordingUi(); return }
    voiceDiscardOnStop = true; resetVoiceRecordingUi()
    if (voiceRecorder.state !== 'inactive') voiceRecorder.stop()
    releaseVoiceCapture().catch(() => {})
  }
  async function startVoiceRecording() {
    if (state.pendingAudio) { toast('请先发送或移除当前录音，再开始新的录制'); return }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('当前浏览器不支持录音，请使用最新版 Chrome 或 Edge'); return }
    if (!window.isSecureContext) { toast('录音需要在 HTTPS 或 localhost 页面中使用'); return }
    const button = $('#voice-record-button'); button.disabled = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const formats = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      const mimeType = formats.find((type) => MediaRecorder.isTypeSupported?.(type))
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream)
      voiceStream = stream; voiceRecorder = recorder; voiceChunks = []; voiceDiscardOnStop = false; voiceStartedAt = Date.now(); voiceOriginChannelId = state.channelId
      recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) voiceChunks.push(event.data) })
      recorder.addEventListener('stop', async () => {
        const actualMime = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]
        const blob = new Blob(voiceChunks, { type: actualMime }); const durationMs = Math.min(MAX_VOICE_MESSAGE_DURATION_MS, Date.now() - voiceStartedAt)
        voiceRecorder = null; voiceChunks = []; await releaseVoiceCapture(); resetVoiceRecordingUi()
        const channelChanged = voiceOriginChannelId !== state.channelId; voiceOriginChannelId = null
        if (voiceDiscardOnStop || channelChanged) { voiceDiscardOnStop = false; return }
        if (blob.size === 0 || durationMs < 500) { toast('录音太短，请至少录制半秒'); return }
        if (blob.size > 8 * 1024 * 1024) { toast('录音文件超过 8 MB，请录短一些后重试'); return }
        const extension = actualMime === 'audio/ogg' ? 'ogg' : actualMime === 'audio/mp4' ? 'm4a' : actualMime === 'audio/mpeg' ? 'mp3' : actualMime === 'audio/wav' ? 'wav' : 'webm'
        const file = new File([blob], `voice-message.${extension}`, { type: actualMime })
        state.pendingAudio = { file, durationMs, previewUrl: URL.createObjectURL(blob), attachmentId: null }
        $('#voice-record-button').disabled = true
        $('#attachment-status').textContent = `语音消息 ${formatVoiceDuration(durationMs)} 待发送`; $('#attachment-status').classList.remove('is-error'); renderPendingAttachments(); $('#message-input').focus()
      }, { once: true })
      recorder.addEventListener('error', () => { cancelVoiceRecording(); toast('录音失败，请检查麦克风权限和设备') }, { once: true })
      recorder.start(250)
      button.disabled = false; button.classList.add('is-recording'); button.title = '正在录音'
      $('#voice-recorder').hidden = false; $('#voice-recorder-title').textContent = '正在录音'; $('#voice-recorder-time').textContent = '00:00'; buildVoiceMeter()
      voiceTimer = setInterval(() => { const elapsed = Date.now() - voiceStartedAt; $('#voice-recorder-time').textContent = formatVoiceDuration(elapsed); if (elapsed >= MAX_VOICE_MESSAGE_DURATION_MS) stopVoiceRecording() }, 100)
      startVoiceMeter(stream)
    } catch (error) {
      button.disabled = false
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') toast('没有麦克风权限，请在浏览器站点设置中允许使用麦克风')
      else if (error.name === 'NotFoundError') toast('没有检测到可用的麦克风')
      else toast(error.message || '无法开始录音')
    }
  }
  function startVoiceMeter(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    try {
      voiceAudioContext = new AudioContextClass(); const source = voiceAudioContext.createMediaStreamSource(stream); const analyser = voiceAudioContext.createAnalyser(); analyser.fftSize = 64
      const silence = voiceAudioContext.createGain(); silence.gain.value = 0; source.connect(analyser); analyser.connect(silence); silence.connect(voiceAudioContext.destination)
      const values = new Uint8Array(analyser.fftSize); const bars = [...$('#voice-meter').children]
      const tick = () => { if (!voiceRecorder || !voiceAudioContext) return; analyser.getByteTimeDomainData(values); let energy = 0; for (const value of values) { const delta = (value - 128) / 128; energy += delta * delta } const level = Math.sqrt(energy / values.length); bars.forEach((bar, index) => { const variation = Math.abs(Math.sin(index * 1.73 + Date.now() / 170)); bar.style.height = `${4 + Math.min(1, level * 4) * (7 + variation * 17)}px` }); voiceAnimationFrame = requestAnimationFrame(tick) }
      voiceAudioContext.resume().then(tick).catch(() => {})
    } catch { /* The timer and recording remain usable without a live meter. */ }
  }
  function stopVoiceRecording() {
    if (!voiceRecorder || voiceRecorder.state === 'inactive') return
    $('#voice-recorder-title').textContent = '正在整理录音…'; $('#voice-record-stop').disabled = true
    voiceRecorder.stop()
  }

  function updateMentionDrafts(previous, next) {
    if (!previous || previous === next) return
    let prefix = 0
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
    let suffix = 0
    while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
    const oldEnd = previous.length - suffix; const newEnd = next.length - suffix; const delta = newEnd - oldEnd
    state.mentions = state.mentions.flatMap((mention) => {
      if (oldEnd <= mention.start) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
      if (prefix >= mention.end) return [mention]
      if (prefix === oldEnd && prefix === mention.end) return [mention]
      return []
    })
  }

  function mentionCandidates() {
    const members = [state.user, ...state.members].filter(Boolean)
    return [...new Map(members.map((member) => [member.id, member])).values()]
      .filter((member) => `${member.displayName} ${member.username || ''}`.toLocaleLowerCase().includes(state.mentionQuery?.query.toLocaleLowerCase() || ''))
  }

  function hideMentionPicker() {
    state.mentionQuery = null; state.mentionIndex = 0
    const picker = $('#mention-picker'); picker.hidden = true; picker.replaceChildren()
    $('#message-input').removeAttribute('aria-activedescendant'); $('#message-input').setAttribute('aria-expanded', 'false')
  }

  function renderMentionPicker() {
    const picker = $('#mention-picker'); const candidates = mentionCandidates()
    picker.replaceChildren()
    const heading = document.createElement('div'); heading.className = 'mention-picker-heading'; heading.textContent = `提及成员 · ${candidates.length}`; picker.append(heading)
    if (!candidates.length) {
      const empty = document.createElement('div'); empty.className = 'mention-option-empty'; empty.textContent = '没有找到匹配的成员'; picker.append(empty)
    } else {
      candidates.forEach((member, index) => {
        const option = document.createElement('button'); option.type = 'button'; option.className = 'mention-option'; option.id = `mention-option-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === state.mentionIndex))
        option.append(makeAvatar(member.avatar || member.displayName?.slice(0, 1), member.color || 'blue'))
        const copy = document.createElement('span'); copy.className = 'mention-option-copy'
        const name = document.createElement('strong'); name.textContent = member.displayName
        const detail = document.createElement('small'); detail.textContent = member.isBot ? '机器人' : member.username ? `@${member.username}` : member.status === 'offline' ? '离线' : '在线'
        copy.append(name, detail); option.append(copy)
        option.addEventListener('mouseenter', () => { state.mentionIndex = index; updateMentionSelection() })
        option.addEventListener('mousedown', (event) => { event.preventDefault(); selectMention(member) })
        picker.append(option)
      })
    }
    picker.hidden = false; $('#message-input').setAttribute('aria-expanded', 'true'); updateMentionSelection()
  }

  function updateMentionSelection() {
    const options = [...$('#mention-picker').querySelectorAll('.mention-option')]
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.mentionIndex)))
    const active = options[state.mentionIndex]
    if (active) { $('#message-input').setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }) }
    else $('#message-input').removeAttribute('aria-activedescendant')
  }

  function refreshMentionPicker() {
    const input = $('#message-input'); const caret = input.selectionStart
    const before = input.value.slice(0, caret)
    const match = before.match(/(^|\s)@([^\s@]*)$/u)
    if (!match || input.selectionStart !== input.selectionEnd) { hideMentionPicker(); return }
    const start = caret - match[0].length + match[1].length
    state.mentionQuery = { start, end: caret, query: match[2] }
    state.mentionIndex = 0; renderMentionPicker()
  }

  function selectMention(member) {
    const input = $('#message-input'); const query = state.mentionQuery
    if (!query) return
    const label = `@${member.displayName}`; const value = input.value
    input.value = value.slice(0, query.start) + label + ' ' + value.slice(query.end)
    const delta = label.length + 1 - (query.end - query.start)
    state.mentions = state.mentions.flatMap((mention) => {
      if (mention.end <= query.start) return [mention]
      if (mention.start >= query.end) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
      return []
    })
    state.mentions.push({ userId: member.id, start: query.start, end: query.start + label.length })
    state.mentions.sort((a, b) => a.start - b.start)
    const caret = query.start + label.length + 1; input.focus(); input.setSelectionRange(caret, caret)
    input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`
    hideMentionPicker(); refreshMentionPicker()
  }

  async function renderChannels() {
    const channels = await api.getChannels(state.serverId); state.channels = channels
    const textList = $('#text-channels'); const voiceList = $('#voice-channels'); textList.replaceChildren(); voiceList.replaceChildren()
    channels.filter((channel) => channel.type === 'text').forEach((channel) => {
      const button = document.createElement('button'); button.className = `channel-row${channel.id === state.channelId ? ' selected' : ''}`; button.dataset.channelId = channel.id
      button.innerHTML = `${icon('hash')}<span class="channel-name"></span>${channel.unread && channel.id !== state.channelId ? `<span class="channel-unread-count" aria-label="${channel.unread} 条未读">${channel.unread > 99 ? '99+' : channel.unread}</span>` : ''}`; $('.channel-name', button).textContent = channel.name
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

  function renderMessageItems(messages, { scrollToBottom = false, scrollToTop = false, scrollToId = null, anchor = null } = {}) {
    const target = $('#messages'); const scroller = $('#message-scroll')
    const widthChanged = state.messageMeasureWidth && Math.abs(state.messageMeasureWidth - target.clientWidth) > 32
    if (widthChanged) state.messageHeights.clear()
    state.messageMeasureWidth = target.clientWidth
    if (!widthChanged) target.querySelectorAll('.message').forEach((article) => { if (article.dataset.messageId) state.messageHeights.set(article.dataset.messageId, article.getBoundingClientRect().height) })
    target.querySelectorAll('.message-attachment img').forEach((image) => attachmentObserver?.unobserve(image))
    const range = messageVirtualRange(messages, scroller, target, { scrollToBottom, scrollToTop, anchor })
    state.renderWindow = { start: range.start, end: range.end }
    target.replaceChildren()
    const searching = isSearching()
    $('#channel-welcome').hidden = messages.length > 0 || searching
    $('#message-search-status').textContent = searching ? `${state.hasMoreMessages ? `最近 ${messages.length} 条匹配消息 · 可加载更早结果` : `${messages.length} 条匹配消息`} · ${state.searchFilters.scope === 'server' ? '整个小队' : `#${currentChannel()?.name || ''}`}` : ''
    if (!messages.length && searching) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = '没有找到符合条件的消息。'; target.append(empty) }
    if (state.hasMoreMessages && (searching || !messages.length)) { const older = document.createElement('button'); older.type = 'button'; older.className = 'load-older-button'; older.textContent = state.loadingOlder ? '正在加载…' : searching ? '加载更早的搜索结果' : '加载更早的消息'; older.addEventListener('click', loadOlderMessages); target.append(older) }
    if (range.start > 0) { const spacer = document.createElement('div'); spacer.className = 'message-virtual-spacer'; spacer.style.height = `${range.prefix[range.start]}px`; spacer.setAttribute('aria-hidden', 'true'); target.append(spacer) }
    let previous = messages[range.start - 1] || null; let previousDate = previous ? dateKey(previous.createdAt) : null
    messages.slice(range.start, range.end).forEach((message, offset) => {
      const currentDate = dateKey(message.createdAt)
      if (currentDate !== previousDate) {
        const divider = document.createElement('div'); divider.className = 'date-divider'; const label = document.createElement('span'); label.textContent = formatDateDivider(message.createdAt); divider.append(label); target.append(divider); previousDate = currentDate
      }
      if (!searching && message.id === state.unreadStartId) { const unreadDivider = document.createElement('div'); unreadDivider.className = 'unread-divider'; unreadDivider.innerHTML = '<span>未读消息</span>'; target.append(unreadDivider) }
      const compact = previous && previous.authorId === message.authorId && dateKey(previous.createdAt) === currentDate && new Date(message.createdAt) - new Date(previous.createdAt) <= 5 * 60_000
      const article = document.createElement('article'); article.className = `message${compact ? ' message-compact' : ''}${searching ? ' search-result-message' : ''}`; article.dataset.messageId = message.id; article.tabIndex = 0; article.setAttribute('aria-label', `${message.author}，${fullDateTime(message.createdAt)}：${message.deletedAt ? '此消息已删除' : message.content || '图片'}`)
      const avatar = makeAvatar(message.avatar, message.color, 'message-avatar'); if (compact) { avatar.setAttribute('aria-hidden', 'true'); avatar.tabIndex = -1 }; article.append(avatar)
      const body = document.createElement('div'); body.className = 'message-body'
      const meta = document.createElement('div'); meta.className = 'message-meta'; const author = document.createElement('strong'); author.textContent = message.author
      if (message.authorId === state.user.id) { const badge = document.createElement('span'); badge.className = 'self-badge'; badge.textContent = '你'; author.append(' ', badge) }
      if (!compact) meta.append(author)
      if (state.searchFilters.scope === 'server' && message.channelName) { const channelLabel = document.createElement('span'); channelLabel.className = 'search-channel-label'; channelLabel.textContent = `#${message.channelName}`; meta.append(channelLabel) }
      const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = formatTime(message.createdAt); time.title = fullDateTime(message.createdAt); time.className = compact ? 'compact-message-time' : ''; meta.append(time)
      if (message.pinned) { const pin = document.createElement('span'); pin.className = 'pinned-label'; pin.innerHTML = `${icon('pin', 'icon tiny')} 已置顶`; meta.append(pin) }
      if (message.editedAt && !message.deletedAt) { const edited = document.createElement('span'); edited.className = 'edited-label'; edited.textContent = '（已编辑）'; meta.append(edited) }
      body.append(meta)
      if (message.deletedAt) {
        article.classList.add('message-deleted')
        const deleted = document.createElement('p'); deleted.className = 'deleted-message-copy'; deleted.textContent = '此消息已删除'; body.append(deleted)
      } else {
        if (message.replyTo) { const reply = document.createElement('button'); reply.type = 'button'; reply.className = 'reply-context'; reply.textContent = `回复 ${message.replyTo.author || '已删除的消息'}：${message.replyTo.content || '内容不可用'}`; reply.title = '跳转到原消息'; reply.addEventListener('click', () => message.replyTo.id && jumpToMessage(message.replyTo.id)); body.append(reply) }
        if (state.editingMessageId === message.id) {
          const editor = document.createElement('div'); editor.className = 'message-edit-editor'
          const textarea = document.createElement('textarea'); textarea.className = 'message-edit-input'; textarea.maxLength = 4000; textarea.value = message.content || ''; textarea.setAttribute('aria-label', '编辑消息')
          textarea.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); saveMessageEdit(message.id) } else if (event.key === 'Escape') { state.editingMessageId = null; renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() }) } })
          const controls = document.createElement('div'); controls.className = 'message-edit-controls'
          const save = document.createElement('button'); save.type = 'button'; save.className = 'message-edit-save'; save.textContent = '保存'; save.addEventListener('click', () => saveMessageEdit(message.id))
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => { state.editingMessageId = null; renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() }) })
          const hint = document.createElement('span'); hint.textContent = 'Esc 取消 · Ctrl/⌘ + Enter 保存'; controls.append(hint, cancel, save); editor.append(textarea, controls); body.append(editor)
        } else {
          const voiceAttachment = (message.attachments || []).find((item) => String(item.mimeType || '').startsWith('audio/'))
          const botVoiceTranscript = message.authorIsBot && voiceAttachment
          if (message.content && !botVoiceTranscript) { const content = document.createElement('p'); renderMessageContent(content, message); body.append(content) }
          renderMessageAttachments(body, message.attachments, botVoiceTranscript ? message.content : '')
        }
        renderMessageSticker(body, message.sticker || message.botSticker)
      }
      if (!message.deletedAt && message.reactions?.length) { const reactions = document.createElement('div'); reactions.className = 'reaction-list'; message.reactions.forEach((reaction) => { const button = document.createElement('button'); button.className = `reaction${reaction.reacted ? ' reacted' : ''}`; button.innerHTML = `<span></span><b></b>`; $('span', button).textContent = reaction.emoji; $('b', button).textContent = reaction.count; button.title = '添加或取消反应'; button.addEventListener('click', () => mutate(() => api.toggleReaction(message.id, reaction.emoji))); reactions.append(button) }); body.append(reactions) }
      article.append(body)
      if (!message.deletedAt && state.editingMessageId !== message.id) {
        const actions = document.createElement('div'); actions.className = 'message-actions'
        actions.append(actionButton('smile-plus', '添加反应', () => openEmojiPicker(message.id)), actionButton('reply', '回复', () => setReply(message)), actionButton('pin', message.pinned ? '取消置顶' : '置顶消息', () => mutate(() => api.togglePin(message.id))), actionButton('more', '更多操作', (event) => toggleMessageMenu(event, article)))
        article.append(actions)
        const menu = document.createElement('div'); menu.className = 'message-menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '消息操作')
        const quickActions = [
          { icon: 'smile-plus', label: '添加反应', run: () => openEmojiPicker(message.id) },
          { icon: 'reply', label: '回复', run: () => setReply(message) },
        ]
        const messageActions = []
        if (message.content) messageActions.push({ icon: 'copy', label: '复制文本', run: () => copyMessageText(message) })
        messageActions.push({ icon: 'pin', label: message.pinned ? '取消置顶' : '置顶消息', run: () => mutate(() => api.togglePin(message.id)) })
        const ownerActions = message.authorId === state.user.id ? [
          { icon: 'edit', label: '编辑消息', run: () => beginMessageEdit(message) },
          { icon: 'trash', label: '删除消息', danger: true, run: () => deleteMessage(message) },
        ] : []
        addMessageMenuGroup(menu, quickActions)
        addMessageMenuGroup(menu, messageActions)
        if (ownerActions.length) addMessageMenuGroup(menu, ownerActions)
        article.append(menu)
      }
      if (searching) { const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'search-jump-button'; jump.textContent = '跳转到消息'; jump.addEventListener('click', () => jumpToMessage(message.id)); article.append(jump) }
      article.dataset.messageIndex = String(range.start + offset)
      target.append(article); previous = message
    })
    if (range.end < messages.length) { const spacer = document.createElement('div'); spacer.className = 'message-virtual-spacer'; spacer.style.height = `${range.prefix[messages.length] - range.prefix[range.end]}px`; spacer.setAttribute('aria-hidden', 'true'); target.append(spacer) }
    requestAnimationFrame(() => {
      target.querySelectorAll('.message').forEach((article) => { if (article.dataset.messageId) state.messageHeights.set(article.dataset.messageId, article.getBoundingClientRect().height) })
      if (scrollToBottom) scroller.scrollTop = scroller.scrollHeight
      else if (scrollToTop) scroller.scrollTop = 0
      else if (scrollToId) target.querySelector(`[data-message-id="${CSS.escape(scrollToId)}"]`)?.scrollIntoView({ block: 'start' })
      else if (anchor?.id) { const item = target.querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`); if (item) scroller.scrollTop += item.getBoundingClientRect().top - anchor.top }
      updateNewMessagePill()
    })
  }

  async function renderMessages({ scrollToBottom = false, keepAnchor = false } = {}) {
    const channel = currentChannel(); if (!channel) return
    const requestVersion = ++state.messageRequestVersion
    const searching = isSearching()
    const anchor = keepAnchor ? currentMessageAnchor() : null
    $('#room-title').textContent = channel.name; $('#room-topic').textContent = channel.topic || '和朋友一起聊天'; $('#welcome-title').textContent = `欢迎来到 #${channel.name}！`; $('#welcome-topic').textContent = `这里是 #${channel.name} 的开始。`; $('#message-input').placeholder = `发送消息到 #${channel.name}`
    const options = searchOptions()
    const page = searching && state.searchFilters.scope === 'server' ? await api.searchServerMessages(state.serverId, options) : await api.getMessages(channel.id, options)
    if (channel.id !== state.channelId || requestVersion !== state.messageRequestVersion) return
    state.messageItems = page.messages || []; state.hasMoreMessages = page.hasMore === true; state.hasNewerMessages = false; state.newMessages = 0
    renderMessageItems(state.messageItems, { scrollToBottom, scrollToTop: searching, anchor })
    if (!searching && state.messageItems.length && scrollToBottom) markLatestRead().catch((error) => console.warn('Could not update read state', error))
  }

  async function loadOlderMessages() {
    if (state.loadingOlder || !state.hasMoreMessages || !state.messageItems.length) return
    state.loadingOlder = true; const channelId = state.channelId; const query = state.search; const filters = JSON.stringify(state.searchFilters); const searching = isSearching()
    const anchor = currentMessageAnchor(); const oldest = state.messageItems[0]
    try {
      const options = searchOptions({ before: oldest.id })
      const page = searching && state.searchFilters.scope === 'server' ? await api.searchServerMessages(state.serverId, options) : await api.getMessages(channelId, options)
      if (channelId !== state.channelId || query !== state.search || filters !== JSON.stringify(state.searchFilters)) return
      const ids = new Set(state.messageItems.map((item) => item.id))
      state.messageItems = [...page.messages.filter((item) => !ids.has(item.id)), ...state.messageItems]
      state.hasMoreMessages = page.hasMore === true
      renderMessageItems(state.messageItems, { anchor })
    } catch (error) { toast(error.message || '加载更早的消息失败') } finally { state.loadingOlder = false }
  }

  async function loadNewerMessages() {
    if (state.loadingNewer || !state.hasNewerMessages || isSearching() || !state.messageItems.length) return
    state.loadingNewer = true; const channelId = state.channelId; const anchor = currentMessageAnchor(); const wasAtBottom = state.atBottom; const newest = state.messageItems.at(-1)
    try {
      const page = await api.getMessages(channelId, { after: newest.id, limit: 50 })
      if (channelId !== state.channelId) return
      const ids = new Set(state.messageItems.map((item) => item.id))
      state.messageItems = [...state.messageItems, ...page.messages.filter((item) => !ids.has(item.id))]
      state.hasNewerMessages = page.hasMore === true
      renderMessageItems(state.messageItems, { anchor: wasAtBottom ? null : anchor, scrollToBottom: wasAtBottom })
      if (wasAtBottom && !state.hasNewerMessages) { state.newMessages = 0; updateNewMessagePill(); markLatestRead().catch((error) => console.warn('Could not update read state', error)) }
    } catch (error) { toast(error.message || '加载更新的消息失败') } finally { state.loadingNewer = false }
  }

  function updateNewMessagePill() {
    const button = $('#new-message-pill'); button.hidden = (state.newMessages === 0 && !state.hasNewerMessages) || isSearching()
    button.textContent = state.newMessages > 99 ? '99+ 条新消息 · 跳到最新' : state.newMessages ? `${state.newMessages} 条新消息 · 跳到最新` : '还有更新的消息 · 加载'
    button.setAttribute('aria-label', button.textContent)
  }

  async function markLatestRead() {
    const channelId = state.channelId
    const latest = state.messageItems.at(-1)
    if (!latest || isSearching()) return
    await api.markChannelRead(channelId, latest.id)
    if (state.channelId !== channelId) return
    if (state.unreadStartId) { const anchor = currentMessageAnchor(); state.unreadStartId = null; renderMessageItems(state.messageItems, { anchor }) }
    await renderChannels()
  }

  async function openChannelMessages(channelId) {
    const channel = state.channels.find((item) => item.id === channelId)
    if (channel?.unread > 0 && channel.unreadMessageId) {
      try {
        const context = await api.getMessageContext(channel.unreadMessageId)
        if (state.channelId !== channelId || context.channelId !== channelId) return
        state.messageItems = context.messages; state.hasMoreMessages = context.hasOlder; state.hasNewerMessages = context.hasNewer
        state.unreadStartId = channel.unreadMessageId; state.newMessages = 0; updateNewMessagePill()
        renderMessageItems(state.messageItems, { scrollToId: state.unreadStartId })
        return
      } catch (error) { console.warn('Could not open unread position', error); toast('未读位置暂时无法加载，请稍后重试') }
    }
    state.unreadStartId = null
    await renderMessages({ scrollToBottom: channel?.unread > 0 ? false : true })
  }

  async function jumpToMessage(messageId) {
    const existing = $('#messages').querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (existing && !isSearching()) { existing.scrollIntoView({ block: 'center', behavior: 'smooth' }); existing.classList.add('message-highlight'); setTimeout(() => existing.classList.remove('message-highlight'), 1800); return }
    const fromChannelId = state.channelId
    try {
      const context = await api.getMessageContext(messageId)
      if (fromChannelId !== state.channelId) return
      if (context.channelId !== state.channelId) await selectChannel(context.channelId)
      state.search = ''; resetSearchFilters(); $('#search-input').value = ''; $('#search-filter-panel').hidden = true; $('#search-filters-button').setAttribute('aria-expanded', 'false'); state.messageItems = context.messages; state.hasMoreMessages = context.hasOlder; state.hasNewerMessages = context.hasNewer; updateNewMessagePill()
      renderMessageItems(state.messageItems)
      requestAnimationFrame(() => { const item = $('#messages').querySelector(`[data-message-id="${CSS.escape(messageId)}"]`); if (item) { item.scrollIntoView({ block: 'center' }); item.classList.add('message-highlight'); setTimeout(() => item.classList.remove('message-highlight'), 1800) } })
    } catch (error) { toast(error.message || '无法定位这条消息') }
  }

  function actionButton(iconName, label, handler) { const button = document.createElement('button'); button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = icon(iconName); button.addEventListener('click', handler); return button }
  function addMessageMenuGroup(menu, actions) {
    if (!actions.length) return
    if (menu.childElementCount) { const separator = document.createElement('div'); separator.className = 'message-menu-separator'; separator.setAttribute('role', 'separator'); menu.append(separator) }
    const group = document.createElement('div'); group.className = 'message-menu-group'; group.setAttribute('role', 'group')
    actions.forEach(({ icon: iconName, label, run, danger = false }) => {
      const item = document.createElement('button'); item.type = 'button'; item.className = `message-menu-item${danger ? ' danger' : ''}`; item.setAttribute('role', 'menuitem'); item.innerHTML = `${icon(iconName, 'icon')}<span></span>`; $('.message-menu-item span', item).textContent = label
      item.addEventListener('click', (event) => { event.stopPropagation(); menu.hidden = true; run() }); group.append(item)
    })
    menu.append(group)
  }
  function closeMessageMenus(except = null) { document.querySelectorAll('.message-menu:not([hidden])').forEach((menu) => { if (menu !== except) { menu.hidden = true; menu.style.visibility = '' } }) }
  function placeMessageMenu(menu, x, y) {
    const margin = 8; menu.hidden = false; menu.style.visibility = 'hidden'; menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - margin))}px`; menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - margin))}px`; menu.style.right = 'auto'
    const rect = menu.getBoundingClientRect(); const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)); const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    menu.style.left = `${left}px`; menu.style.top = `${top}px`; menu.style.visibility = ''
  }
  function toggleMessageMenu(event, article) {
    const menu = article?.querySelector('.message-menu'); if (!menu) return
    event.preventDefault(); event.stopPropagation(); const open = !menu.hidden
    closeMessageMenus(menu)
    if (!open) { const rect = article.getBoundingClientRect(); const x = event.clientX || rect.right - 12; const y = event.clientY || rect.top + 12; placeMessageMenu(menu, x + 4, y + 4) }
    else menu.hidden = true
  }
  async function copyMessageText(message) {
    try { await navigator.clipboard.writeText(message.content); toast('消息文本已复制') }
    catch { toast('无法访问剪贴板，请手动选择消息文本') }
  }
  function beginMessageEdit(message) {
    state.editingMessageId = message.id
    renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() })
    requestAnimationFrame(() => { const editor = $('#messages').querySelector(`[data-message-id="${CSS.escape(message.id)}"] .message-edit-input`); editor?.focus(); editor?.setSelectionRange(editor.value.length, editor.value.length) })
  }
  async function saveMessageEdit(messageId) {
    const editor = $('#messages').querySelector(`[data-message-id="${CSS.escape(messageId)}"] .message-edit-input`)
    if (!editor) return
    const content = editor.value.trim(); if (!content) { toast('消息内容不能为空'); editor.focus(); return }
    try {
      const updated = await api.editMessage(messageId, content)
      state.messageItems = state.messageItems.map((item) => item.id === messageId ? { ...item, ...updated } : item)
      state.editingMessageId = null
      if (isSearching()) await renderMessages()
      else renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() })
      toast('消息已编辑')
    } catch (error) { toast(error.message || '编辑消息失败') }
  }
  async function deleteMessage(message) {
    if (!window.confirm('确定删除这条消息吗？删除后，图片附件也会一并移除。')) return
    try {
      const result = await api.deleteMessage(message.id)
      for (const attachment of message.attachments || []) { const cached = attachmentUrlCache.get(attachment.id); if (cached) cached.then((url) => URL.revokeObjectURL(url)).catch(() => {}); attachmentUrlCache.delete(attachment.id) }
      state.messageItems = state.messageItems.map((item) => item.id === message.id ? { ...item, content: '', mentions: [], attachments: [], reactions: [], pinned: false, deletedAt: result.deletedAt || new Date().toISOString() } : item)
      state.editingMessageId = null
      if (isSearching()) await renderMessages()
      else renderMessageItems(state.messageItems, { anchor: currentMessageAnchor() })
      if (state.pinsOpen) renderPins(); toast('消息已删除')
    } catch (error) { toast(error.message || '删除消息失败') }
  }
  async function renderPins() {
    const result = await api.getPins(state.channelId); const pins = result.messages || []; const target = $('#pins-list'); target.replaceChildren()
    if (!pins.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '这里还没有置顶消息。'; target.append(empty); return }
    pins.forEach((message) => { const card = document.createElement('button'); card.type = 'button'; card.className = 'pin-card'; const title = document.createElement('strong'); title.textContent = message.author; const text = document.createElement('span'); text.textContent = message.content || '图片'; const date = document.createElement('time'); date.textContent = formatTime(message.createdAt); card.append(title, date, text); card.addEventListener('click', () => jumpToMessage(message.id)); target.append(card) })
  }
  async function mutate(action) {
    const anchor = currentMessageAnchor(); const updated = await action()
    if (updated?.id) state.messageItems = state.messageItems.map((item) => item.id === updated.id ? { ...item, ...updated } : item)
    renderMessageItems(state.messageItems, { anchor })
    if (state.pinsOpen) renderPins()
  }
  async function refreshMessageInPlace(messageId) {
    if (!state.messageItems.some((item) => item.id === messageId)) return
    const anchor = currentMessageAnchor()
    try {
      const context = await api.getMessageContext(messageId)
      const fresh = context.messages.find((item) => item.id === messageId)
      if (!fresh || context.channelId !== state.channelId) return
      const index = state.messageItems.findIndex((item) => item.id === messageId); if (index < 0) return
      state.messageItems[index] = fresh
      renderMessageItems(state.messageItems, { anchor })
      if (state.pinsOpen) renderPins().catch((error) => console.warn('Could not refresh pinned messages', error))
    } catch (error) { console.warn('Could not refresh message', error) }
  }
  async function selectServer(id) { if (state.pendingAttachments.length || state.pendingAudio || voiceRecorder) clearPendingAttachments(); if (state.joined) { state.joined = false; $('#voice-connected').hidden = true; $('#join-button').textContent = '加入语音' } state.serverId = id; state.expressionGroupId = { emoji: '', sticker: '' }; state.channels = await api.getChannels(id); state.expressions = await api.getExpressions(id).catch(() => ({ emojis: [], stickers: [], groups: { emoji: [], sticker: [] } })); state.channelId = state.channels.find((channel) => channel.type === 'text')?.id; state.voiceChannelId = state.channels.find((channel) => channel.type === 'voice')?.id; state.editingMessageId = null; state.newMessages = 0; state.hasMoreMessages = false; state.hasNewerMessages = false; state.unreadStartId = null; state.messageItems = []; await renderChannels(); await openChannelMessages(state.channelId); await renderMembers() }
  async function selectChannel(id) { if (state.pendingAttachments.length || state.pendingAudio || voiceRecorder) clearPendingAttachments(); setChannelDrawer(false); document.querySelector('.app-shell').classList.remove('room-view'); document.querySelector('#game-pane').hidden = true; window.dispatchEvent(new Event('echo:chat-view')); state.channelId = id; state.messageHeights.clear(); state.renderWindow = null; state.search = ''; resetSearchFilters(); state.editingMessageId = null; state.newMessages = 0; state.hasMoreMessages = false; state.hasNewerMessages = false; state.unreadStartId = null; state.messageItems = []; $('#search-input').value = ''; $('#search-filter-panel').hidden = true; $('#search-filters-button').setAttribute('aria-expanded', 'false'); updateNewMessagePill(); await renderChannels(); await openChannelMessages(id) }
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
    const popover = $('#emoji-popover'); popover.removeAttribute('style'); popover.replaceChildren(); popover.className = 'emoji-popover reaction-picker'; ['👍', '❤️', '😂', '🎮', '🔥', '🙌', '🎉', '👀'].forEach((emoji) => { const button = document.createElement('button'); button.textContent = emoji; button.title = `反应 ${emoji}`; button.addEventListener('click', async () => { await api.toggleReaction(messageId, emoji); popover.hidden = true; renderMessages() }); popover.append(button) }); popover.hidden = false
  }
  function insertComposerText(value) {
    const input = $('#message-input'); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start
    input.value = input.value.slice(0, start) + value + input.value.slice(end); input.focus(); const cursor = start + value.length; input.setSelectionRange(cursor, cursor); input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  function expressionButton(expression, kind) {
    const card = document.createElement('div'); card.className = `expression-item ${kind === 'sticker' ? 'sticker-item' : ''}`
    const button = document.createElement('button'); button.type = 'button'; button.className = 'expression-select'; button.title = kind === 'emoji' ? `:${expression.name}:` : expression.name
    const image = document.createElement('img'); image.alt = expression.name; image.echoExpression = expression; loadExpressionImage(image); button.append(image)
    if (kind === 'sticker') { const label = document.createElement('span'); label.textContent = expression.name; button.append(label) }
    button.addEventListener('click', async () => {
      const popover = $('#emoji-popover'); popover.hidden = true
      if (kind === 'emoji') { insertComposerText(`:${expression.name}:`); return }
      try { await api.sendMessage(state.channelId, { content: '', stickerId: expression.id }); await renderMessages({ scrollToBottom: true }) } catch (error) { toast(error.message || '发送表情包失败') }
    })
    card.append(button)
    if ((expression.scope === 'personal' && expression.ownerUserId === state.user.id) || (expression.scope === 'system' && state.expressions.canManageSystem)) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'expression-remove'; remove.title = '移除这个表情'; remove.setAttribute('aria-label', `移除 ${expression.name}`); remove.innerHTML = icon('close'); remove.addEventListener('click', async () => { try { await api.deleteExpression(expression.id); state.expressions = await api.getExpressions(state.serverId); await renderMessages(); renderExpressionPicker() } catch (error) { toast(error.message || '移除失败') } }); card.append(remove)
    }
    return card
  }
  async function manageExpressionGroup(action, kind, group) {
    try {
      if (action === 'create') { const name = window.prompt(kind === 'emoji' ? '新建 Emoji 分组名称' : '新建表情包分组名称'); if (!name?.trim()) return; const result = await api.createExpressionGroup(state.serverId, kind, name.trim(), state.expressionScope); state.expressionGroupId[kind] = result.group.id }
      if (action === 'rename' && group) { const name = window.prompt('修改分组名称', group.name); if (!name?.trim() || name.trim() === group.name) return; await api.renameExpressionGroup(group.id, name.trim()) }
      if (action === 'delete' && group) { if (!window.confirm(`删除分组“${group.name}”？其中的表情会移到“未分组”，不会删除图片。`)) return; await api.deleteExpressionGroup(group.id); state.expressionGroupId[kind] = '' }
      state.expressions = await api.getExpressions(state.serverId); renderExpressionPicker()
    } catch (error) { toast(error.message || '分组操作失败') }
  }
  function renderExpressionPicker() {
    const popover = $('#emoji-popover'); popover.className = 'emoji-popover expression-picker'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', '表情选择器'); popover.replaceChildren()
    popover.onclick = (event) => event.stopPropagation()
    const trigger = $('#emoji-button').getBoundingClientRect(); const panelWidth = Math.min(420, window.innerWidth - 24); popover.style.position = 'fixed'; popover.style.left = `${Math.max(12, Math.min(window.innerWidth - panelWidth - 12, trigger.right - panelWidth))}px`; popover.style.right = 'auto'; popover.style.bottom = `${Math.max(12, window.innerHeight - trigger.top + 10)}px`
    const header = document.createElement('div'); header.className = 'expression-picker-heading'; const title = document.createElement('strong'); title.textContent = '表情'; const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.title = '关闭'; close.innerHTML = icon('close'); close.addEventListener('click', () => { popover.hidden = true }); header.append(title, close); popover.append(header)
    const tabs = document.createElement('div'); tabs.className = 'expression-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '表情类别'); [['emoji','Emoji'],['sticker','表情包']].forEach(([key,label]) => { const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(state.expressionTab === key)); button.textContent = label; button.classList.toggle('selected', state.expressionTab === key); button.addEventListener('click', () => { state.expressionTab = key; renderExpressionPicker() }); tabs.append(button) }); popover.append(tabs)
    const tools = document.createElement('div'); tools.className = 'expression-tools'; const search = document.createElement('input'); search.type = 'search'; search.placeholder = state.expressionTab === 'sticker' ? '搜索表情包名称' : '搜索 Emoji 或关键词'; search.value = state.expressionQuery; search.setAttribute('aria-label', '搜索表情'); search.addEventListener('input', () => { state.expressionQuery = search.value; renderExpressionPicker(); $('#emoji-popover input[type=search]')?.focus(); const current = $('#emoji-popover input[type=search]'); current?.setSelectionRange(current.value.length, current.value.length) }); tools.append(search)
    if (state.expressionTab === 'sticker') { const canUploadHere = state.expressionScope === 'personal' || state.expressions.canManageSystem; if (canUploadHere) { const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'expression-upload'; upload.innerHTML = `${icon('plus')}<span>批量上传</span>`; upload.addEventListener('click', () => { const picker = $('#expression-picker'); picker.dataset.kind = 'sticker'; picker.dataset.scope = state.expressionScope; picker.click() }); tools.append(upload) } }
    popover.append(tools)
    const list = document.createElement('div'); list.className = 'expression-grid-scroll'
    const query = state.expressionQuery.trim().toLocaleLowerCase()
    if (state.expressionTab === 'emoji') {
      EMOJI_GROUPS.forEach((group) => { const matching = group.items.filter((item) => !query || item.includes(query) || (EMOJI_KEYWORDS[item] || '').includes(query) || group.name.toLocaleLowerCase().includes(query) || group.terms.includes(query)); if (!matching.length) return; const heading = document.createElement('h3'); heading.textContent = group.name; list.append(heading); const grid = document.createElement('div'); grid.className = 'unicode-emoji-grid'; matching.forEach((emoji) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji; button.title = `${group.name} ${EMOJI_KEYWORDS[emoji] || ''} ${emoji}`; button.addEventListener('click', () => { popover.hidden = true; insertComposerText(emoji) }); grid.append(button) }); list.append(grid) })
    } else {
      const kind = 'sticker'; const groups = (state.expressions.groups?.sticker || []).filter((group) => group.scope === state.expressionScope); const selectedGroupId = state.expressionGroupId.sticker || ''
      const libraryBar = document.createElement('div'); libraryBar.className = 'expression-library-bar'; const scopeTabs = document.createElement('div'); scopeTabs.className = 'expression-scope-tabs'; scopeTabs.setAttribute('role', 'tablist'); scopeTabs.setAttribute('aria-label', '表情包库范围')
      [['system','系统默认'],['personal','我的表情']].forEach(([value,label]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.classList.toggle('selected', state.expressionScope === value); button.setAttribute('aria-pressed', String(state.expressionScope === value)); button.addEventListener('click', () => { state.expressionScope = value; state.expressionGroupId.sticker = ''; renderExpressionPicker() }); scopeTabs.append(button) })
      libraryBar.append(scopeTabs)
      if (state.expressionScope === 'personal' || state.expressions.canManageSystem) { const addGroup = document.createElement('button'); addGroup.type = 'button'; addGroup.className = 'expression-group-create'; addGroup.innerHTML = `${icon('plus')}<span>新建分组</span>`; addGroup.addEventListener('click', () => manageExpressionGroup('create', kind)); libraryBar.append(addGroup) }
      list.append(libraryBar)
      const groupNav = document.createElement('div'); groupNav.className = 'expression-group-nav'; const groupChoices = [{ id: '', name: '全部' }, ...groups]
      groupChoices.forEach((group) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'expression-group-chip'; button.classList.toggle('selected', (group.id || '') === selectedGroupId); button.textContent = group.name; button.addEventListener('click', () => { state.expressionGroupId.sticker = group.id || ''; renderExpressionPicker() }); groupNav.append(button) })
      const activeGroup = groups.find((group) => group.id === selectedGroupId)
      if (activeGroup && (activeGroup.ownerUserId === state.user.id || (activeGroup.scope === 'system' && state.expressions.canManageSystem))) { const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'expression-group-action'; rename.title = '重命名分组'; rename.setAttribute('aria-label', '重命名分组'); rename.innerHTML = icon('edit'); rename.addEventListener('click', () => manageExpressionGroup('rename', kind, activeGroup)); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'expression-group-action danger'; remove.title = '删除分组'; remove.setAttribute('aria-label', '删除分组'); remove.innerHTML = icon('trash'); remove.addEventListener('click', () => manageExpressionGroup('delete', kind, activeGroup)); groupNav.append(rename, remove) }
      list.append(groupNav)
      const expressions = state.expressions.stickers.filter((item) => item.scope === state.expressionScope && (!selectedGroupId || item.groupId === selectedGroupId) && (!query || item.name.toLocaleLowerCase().includes(query)))
      if (!expressions.length) { const empty = document.createElement('div'); empty.className = 'expression-empty'; empty.innerHTML = `${icon('image')}<strong>${state.expressionScope === 'system' ? '系统默认库' : '个人库'}还没有表情包</strong><span>${state.expressionScope === 'personal' ? '上传后只有你能从选择器中使用。' : state.expressions.canManageSystem ? '管理员可以上传供所有人使用的默认资源。' : '系统资源由 Echo 管理员维护。'}</span>`; list.append(empty) } else {
        const byGroup = new Map(groups.filter((group) => !selectedGroupId || group.id === selectedGroupId).map((group) => [group.id, { name: group.name, items: [] }]))
        byGroup.set('', { name: '未分组', items: [] }); expressions.forEach((item) => { const key = item.groupId || ''; if (!byGroup.has(key)) byGroup.set(key, { name: '未分组', items: [] }); byGroup.get(key).items.push(item) })
        for (const group of byGroup.values()) { if (!group.items.length) continue; const section = document.createElement('section'); section.className = 'expression-group-section'; const heading = document.createElement('h3'); heading.textContent = group.name; const grid = document.createElement('div'); grid.className = 'custom-expression-grid'; group.items.forEach((item) => grid.append(expressionButton(item, kind))); section.append(heading, grid); list.append(section) }
      }
    }
    popover.append(list); popover.hidden = false
  }

  $('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.sendingMessage) return
    const input = $('#message-input'); const rawContent = input.value; const leading = rawContent.length - rawContent.trimStart().length; const content = rawContent.trim(); if (!content && !state.pendingAttachments.length && !state.pendingAudio) return
    const mentions = state.mentions.filter((mention) => mention.start >= leading && mention.end <= leading + content.length).map((mention) => ({ ...mention, start: mention.start - leading, end: mention.end - leading }))
    state.sendingMessage = true
    const sendButton = $('#message-form button[type="submit"]'); sendButton.disabled = true; input.disabled = true; $('#image-picker').disabled = true; $('#attachment-button').disabled = true; $('#emoji-button').disabled = true; $('#voice-record-button').disabled = true; renderPendingAttachments()
    try {
      for (let index = 0; index < state.pendingAttachments.length; index++) {
        const item = state.pendingAttachments[index]
        if (item.attachmentId) continue
        $('#attachment-status').textContent = `正在上传图片 ${index + 1}/${state.pendingAttachments.length}…`
        const result = await api.uploadAttachment(state.channelId, item.file)
        item.attachmentId = result.attachment.id; item.attachment = result.attachment
      }
      if (state.pendingAudio && !state.pendingAudio.attachmentId) {
        $('#attachment-status').textContent = '正在上传语音…'
        const result = await api.uploadVoiceMessage(state.channelId, state.pendingAudio.file, state.pendingAudio.durationMs)
        state.pendingAudio.attachmentId = result.attachment.id
      }
      await api.sendMessage(state.channelId, { content, mentions, attachmentIds: state.pendingAttachments.map((item) => item.attachmentId), audioAttachmentId: state.pendingAudio?.attachmentId || null, replyTo: state.replyTo ? { id: state.replyTo.id, author: state.replyTo.author, content: state.replyTo.content } : null })
      input.value = ''; state.mentions = []; hideMentionPicker(); input.style.height = 'auto'; clearPendingAttachments(); state.replyTo = null; $('#reply-preview').hidden = true; state.search = ''; resetSearchFilters(); $('#search-input').value = ''; await renderMessages({ scrollToBottom: true })
    } catch (error) { $('#attachment-status').textContent = error.message || '发送失败'; $('#attachment-status').classList.add('is-error'); toast(error.message || '发送失败') }
    finally { state.sendingMessage = false; sendButton.disabled = false; input.disabled = false; $('#image-picker').disabled = false; $('#attachment-button').disabled = false; $('#emoji-button').disabled = false; $('#voice-record-button').disabled = Boolean(state.pendingAudio); renderPendingAttachments() }
  })
  $('#message-input').addEventListener('beforeinput', (event) => { state.inputBeforeEdit = event.currentTarget.value })
  $('#message-input').addEventListener('keydown', (event) => {
    if (!$('#mention-picker').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const count = $('#mention-picker').querySelectorAll('.mention-option').length
      if (count) { state.mentionIndex = (state.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; updateMentionSelection() }
      return
    }
    if (!$('#mention-picker').hidden && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      const member = mentionCandidates()[state.mentionIndex]
      if (member) { event.preventDefault(); selectMention(member) }
      return
    }
    if (event.key === 'Escape' && !$('#mention-picker').hidden) { event.preventDefault(); hideMentionPicker(); return }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#message-form').requestSubmit() }
  })
  $('#message-input').addEventListener('input', (event) => { const input = event.currentTarget; updateMentionDrafts(state.inputBeforeEdit, input.value); state.inputBeforeEdit = null; input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; refreshMentionPicker() })
  $('#message-input').addEventListener('click', refreshMentionPicker)
  $('#message-input').addEventListener('keyup', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refreshMentionPicker() })
  function syncSearchFilterControls() {
    const author = $('#search-author'); const selected = state.searchFilters.authorId
    author.replaceChildren(); const everyone = document.createElement('option'); everyone.value = ''; everyone.textContent = '所有成员'; author.append(everyone)
    state.members.forEach((member) => { const option = document.createElement('option'); option.value = member.id; option.textContent = member.displayName; author.append(option) })
    author.value = selected
    $('#search-scope').value = state.searchFilters.scope; $('#search-from-date').value = state.searchFilters.fromDate; $('#search-to-date').value = state.searchFilters.toDate; $('#search-has-image').checked = state.searchFilters.hasImage
  }
  function updateSearchFilterButton() {
    const filters = state.searchFilters
    $('#search-filters-button').classList.toggle('action-active', filters.scope === 'server' || Boolean(filters.authorId || filters.fromDate || filters.toDate || filters.hasImage))
  }
  function resetSearchFilters() {
    state.searchFilters = { scope: 'channel', authorId: '', fromDate: '', toDate: '', hasImage: false }
    syncSearchFilterControls(); updateSearchFilterButton()
  }
  $('#search-filters-button').addEventListener('click', () => {
    const panel = $('#search-filter-panel'); const open = panel.hidden
    if (open) syncSearchFilterControls()
    panel.hidden = !open; $('#search-filters-button').setAttribute('aria-expanded', String(open))
  })
  $('#search-clear-filters').addEventListener('click', () => { resetSearchFilters(); renderMessages({ scrollToTop: true, scrollToBottom: !isSearching() }).catch((error) => toast(error.message || '更新搜索失败')) })
  $('#search-apply-filters').addEventListener('click', () => {
    const next = { scope: $('#search-scope').value, authorId: $('#search-author').value, fromDate: $('#search-from-date').value, toDate: $('#search-to-date').value, hasImage: $('#search-has-image').checked }
    if (next.fromDate && next.toDate && next.fromDate > next.toDate) { toast('开始日期不能晚于结束日期'); return }
    if (next.scope === 'server' && !state.search && !next.authorId && !next.fromDate && !next.toDate && !next.hasImage) { toast('请先输入关键词或至少选择一个筛选条件'); return }
    state.searchFilters = next; updateSearchFilterButton(); clearTimeout(state.searchTimer)
    $('#search-filter-panel').hidden = true; $('#search-filters-button').setAttribute('aria-expanded', 'false')
    renderMessages({ scrollToTop: true, scrollToBottom: !isSearching() }).catch((error) => toast(error.message || '搜索消息失败'))
  })
  $('#search-input').addEventListener('input', (event) => {
    state.search = event.currentTarget.value.trim(); clearTimeout(state.searchTimer)
    state.searchTimer = setTimeout(() => renderMessages({ scrollToTop: true }).catch((error) => toast(error.message || '搜索消息失败')), 220)
  })
  $('#search-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { clearTimeout(state.searchTimer); renderMessages({ scrollToTop: true }).catch((error) => toast(error.message || '搜索消息失败')) } else if (event.key === 'Escape' && isSearching()) { event.currentTarget.value = ''; state.search = ''; resetSearchFilters(); clearTimeout(state.searchTimer); renderMessages({ scrollToBottom: true }).catch(console.error) } })
  $('#message-scroll').addEventListener('scroll', () => {
    state.atBottom = isNearBottom()
    scheduleVirtualRender()
    if (state.atBottom && state.hasNewerMessages && !isSearching()) loadNewerMessages()
    if (state.atBottom && (state.newMessages || state.unreadStartId) && !state.hasNewerMessages && !isSearching()) { state.newMessages = 0; updateNewMessagePill(); markLatestRead().catch((error) => console.warn('Could not update read state', error)) }
    if (!isSearching() && $('#message-scroll').scrollTop < 90) loadOlderMessages()
  }, { passive: true })
  $('#message-scroll').addEventListener('wheel', closeMessageMenus, { passive: true })
  $('#message-scroll').addEventListener('touchmove', closeMessageMenus, { passive: true })
  $('#message-scroll').addEventListener('pointerdown', (event) => { if (event.button === 0 && !event.target.closest('.message-menu')) closeMessageMenus() }, { passive: true })
  window.addEventListener('resize', () => {
    if (state.messageItems.length <= VIRTUAL_MESSAGE_THRESHOLD) return
    const atBottom = state.atBottom; const anchor = atBottom ? null : currentMessageAnchor()
    state.messageHeights.clear(); state.renderWindow = null
    renderMessageItems(state.messageItems, { anchor, scrollToBottom: atBottom })
  })
  function setChannelDrawer(open) {
    document.querySelector('.app-shell').classList.toggle('channels-open', open)
    $('#toggle-channels').setAttribute('aria-expanded', String(open))
    $('#toggle-channels').setAttribute('aria-label', open ? '关闭频道列表' : '打开频道列表')
    $('#channel-sidebar-scrim').hidden = !open
  }
  $('#toggle-channels').addEventListener('click', () => setChannelDrawer(!document.querySelector('.app-shell').classList.contains('channels-open')))
  $('#channel-sidebar-scrim').addEventListener('click', () => setChannelDrawer(false))
  $('#new-message-pill').addEventListener('click', () => (state.newMessages ? renderMessages({ scrollToBottom: true }) : loadNewerMessages()).catch((error) => toast(error.message || '无法加载消息')))
  $('#messages').addEventListener('keydown', (event) => {
    const article = event.target.closest('.message'); if (!article || event.target !== article) return
    const items = [...$('#messages').querySelectorAll('.message')]; const index = items.indexOf(article)
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus() }
    else if (event.key.toLowerCase() === 'r') { event.preventDefault(); const message = state.messageItems.find((item) => item.id === article.dataset.messageId); if (message) setReply(message) }
    else if (event.key.toLowerCase() === 'p') { event.preventDefault(); mutate(() => api.togglePin(article.dataset.messageId)).catch((error) => toast(error.message || '置顶操作失败')) }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); openEmojiPicker(article.dataset.messageId) }
    else if (event.key === 'Escape') { event.preventDefault(); $('#message-input').focus() }
  })
  document.addEventListener('contextmenu', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement
    if (!target) return
    const inMenu = target.closest('.message-menu'); const article = target.closest('.message'); const menuAlreadyOpen = document.querySelector('.message-menu:not([hidden])')
    if (inMenu) { event.preventDefault(); event.stopPropagation(); return }
    if (article && !article.classList.contains('message-deleted') && !target.closest('textarea,input,[contenteditable="true"]')) { event.preventDefault(); event.stopPropagation(); toggleMessageMenu(event, article); return }
    if (menuAlreadyOpen) { event.preventDefault(); event.stopPropagation(); closeMessageMenus() }
  })
  document.addEventListener('click', (event) => { if (!event.target.closest('.message-menu') && !event.target.closest('.message-actions [aria-label="更多操作"]')) closeMessageMenus(); if (!event.target.closest('#search-filter-panel,#search-filters-button')) { $('#search-filter-panel').hidden = true; $('#search-filters-button').setAttribute('aria-expanded', 'false') } })
  document.addEventListener('keydown', (event) => { if (event.defaultPrevented || event.target.closest('[role=dialog],dialog[open]')) return; if (event.key === 'Escape' && event.target.closest('.message-menu')) { event.preventDefault(); const article = event.target.closest('.message'); closeMessageMenus(); article?.focus({ preventScroll: true }); return } if ((event.ctrlKey || event.metaKey) && ['k', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); $('#search-input').focus() } else if (event.key === 'Escape') { closeMessageMenus(); $('#search-filter-panel').hidden = true; $('#search-filters-button').setAttribute('aria-expanded', 'false'); $('#emoji-popover').hidden = true; if (!$('#mention-picker').hidden) hideMentionPicker(); $('#search-input').blur(); setChannelDrawer(false) } })
  document.addEventListener('keydown', (event) => {
    const item = event.target.closest('.message-menu [role="menuitem"]'); if (!item) return
    const items = [...item.closest('.message-menu').querySelectorAll('[role="menuitem"]')]; const index = items.indexOf(item)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
  })
  $('#toggle-members').addEventListener('click', () => { const sidebar = $('#member-sidebar'); sidebar.classList.toggle('hidden'); $('#toggle-members').classList.toggle('action-active', !sidebar.classList.contains('hidden')) })
  $('#pins-button').addEventListener('click', async () => { state.pinsOpen = !state.pinsOpen; $('#pins-panel').hidden = !state.pinsOpen; if (state.pinsOpen) await renderPins() })
  $('#close-pins').addEventListener('click', () => { state.pinsOpen = false; $('#pins-panel').hidden = true })
  $('#join-button').addEventListener('click', () => state.joined ? disconnectVoice() : connectVoice())
  $('#leave-voice').addEventListener('click', disconnectVoice)
  $('#mute-button').addEventListener('click', async (event) => { state.muted = !state.muted; try { if (api.mode === 'http' && state.joined) await window.EchoVoice.setMuted(state.muted); event.currentTarget.innerHTML = icon(state.muted ? 'mic-off' : 'mic'); event.currentTarget.classList.toggle('action-active', state.muted); event.currentTarget.title = state.muted ? '取消静音' : '静音'; toast(state.muted ? `麦克风已静音${api.mode === 'mock' ? '（演示）' : ''}` : `麦克风已开启${api.mode === 'mock' ? '（演示）' : ''}`) } catch (error) { state.muted = !state.muted; toast(error.message || '麦克风状态更新失败') } })
  $('#deafen-button').addEventListener('click', async (event) => { state.deafened = !state.deafened; if (api.mode === 'http' && state.joined) window.EchoVoice.setDeafened(state.deafened); event.currentTarget.innerHTML = icon(state.deafened ? 'headphones-off' : 'headphones'); event.currentTarget.classList.toggle('action-active', state.deafened); event.currentTarget.title = state.deafened ? '取消耳机静音' : '耳机静音' })
  $('#emoji-button').addEventListener('click', async () => { const popover = $('#emoji-popover'); if (!popover.hidden && popover.classList.contains('expression-picker')) { popover.hidden = true; return } state.expressionTab = 'emoji'; state.expressionQuery = ''; try { state.expressions = await api.getExpressions(state.serverId) } catch { /* Keep the last loaded picker data available offline. */ } renderExpressionPicker() })
  $('#invite-button').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('邀请链接已复制') } catch { toast('邀请链接：' + location.href) } })
  $('#attachment-button').addEventListener('click', () => $('#image-picker').click())
  $('#voice-record-button').addEventListener('click', () => { if (voiceRecorder) return; startVoiceRecording() })
  $('#voice-record-stop').addEventListener('click', stopVoiceRecording)
  $('#voice-record-cancel').addEventListener('click', () => { cancelVoiceRecording(); toast('已取消录音') })
  $('#expression-picker').addEventListener('change', async (event) => {
    const files = [...event.currentTarget.files]; const scope = event.currentTarget.dataset.scope || 'personal'; event.currentTarget.value = ''; if (!files.length) return
    const groups = (state.expressions.groups?.sticker || []).filter((group) => group.scope === scope)
    window.EchoStickerUpload.open({ title: '批量上传表情包', subtitle: `${scope === 'system' ? '系统默认库' : '我的个人库'} · 每张图片可单独填写名称和分组。单张最多 2 MB。`, scope, files, nameLabel: '表情名称', nameMax: 40, maxSize: 2 * 1024 * 1024, groups: () => groups, defaultGroupId: state.expressionGroupId.sticker || '', onCreateGroup: async (name) => { const result = await api.createExpressionGroup(state.serverId, 'sticker', name, scope); groups.push(result.group); state.expressionGroupId.sticker = result.group.id }, onUpload: async ({ file, name, groupId }) => { await api.uploadExpression(state.serverId, 'sticker', file, name, groupId, scope) }, onComplete: async ({ succeeded }) => { if (!succeeded) return; state.expressions = await api.getExpressions(state.serverId); state.expressionScope = scope; state.expressionTab = 'sticker'; state.expressionQuery = ''; renderExpressionPicker(); toast(scope === 'system' ? `系统默认库已上传 ${succeeded} 项` : `个人表情库已上传 ${succeeded} 项`) } })
  })
  $('#image-picker').addEventListener('change', (event) => {
    const files = [...event.currentTarget.files]; event.currentTarget.value = ''
    const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    let totalSize = state.pendingAttachments.reduce((sum, item) => sum + item.file.size, 0)
    for (const file of files) {
      if (state.pendingAttachments.length >= 10) { toast('一条消息最多添加 10 张图片'); break }
      if (!allowed.has(file.type)) { toast(`${file.name} 格式不支持，请选择 PNG、JPEG、GIF 或 WebP`); continue }
      const perFileLimit = api.mode === 'mock' ? 2 * 1024 * 1024 : 8 * 1024 * 1024
      if (!file.size || file.size > perFileLimit) { toast(`${file.name} 超过 ${api.mode === 'mock' ? '2' : '8'} MB 限制`); continue }
      if (totalSize + file.size > 24 * 1024 * 1024) { toast('单条消息图片总大小不能超过 24 MB'); break }
      totalSize += file.size
      state.pendingAttachments.push({ file, previewUrl: URL.createObjectURL(file), attachmentId: null })
    }
    $('#attachment-status').classList.remove('is-error'); $('#attachment-status').textContent = [state.pendingAttachments.length ? `${state.pendingAttachments.length} 张图片` : '', state.pendingAudio ? '1 条语音' : ''].filter(Boolean).join(' · ') + (state.pendingAttachments.length || state.pendingAudio ? '待发送' : '')
    renderPendingAttachments(); $('#message-input').focus()
  })
  window.addEventListener('echo:signed-out', clearPendingAttachments)
  api.subscribe('auth.expired', clearPendingAttachments)
  $('.header-actions button[title="通知"]').addEventListener('click', () => toast('暂无新通知'))
  document.addEventListener('click', (event) => { if (!event.target.closest('#emoji-popover') && !event.target.closest('#emoji-button') && !event.target.closest('.message-actions')) $('#emoji-popover').hidden = true })
  document.querySelectorAll('.create-channel').forEach((button) => button.addEventListener('click', async () => { const name = window.prompt(button.dataset.type === 'voice' ? '新语音频道名称' : '新文字频道名称'); if (!name?.trim()) return; try { const channel = await api.createChannel(state.serverId, { name, type: button.dataset.type }); if (channel.type === 'text') state.channelId = channel.id; else state.voiceChannelId = channel.id; await renderChannels(); if (channel.type === 'text') renderMessages(); toast(api.mode === 'mock' ? '频道已创建（mock）' : '频道已创建') } catch (error) { toast(error.message || '创建频道失败') } }))
  api.subscribe('message.created', (message) => {
    if (message.channelId !== state.channelId) { renderChannels().catch(() => {}); return }
    if (isSearching()) return
    if (isNearBottom()) renderMessages({ scrollToBottom: true }).catch((error) => toast(error.message || '刷新消息失败'))
    else { state.newMessages += 1; state.hasNewerMessages = true; updateNewMessagePill(); renderChannels().catch(() => {}) }
  })
  api.subscribe('expression.created', ({ serverId, expression }) => { if (serverId !== state.serverId) return; if (expression.scope === 'personal' && expression.ownerUserId !== state.user.id) return; const key = expression.kind === 'emoji' ? 'emojis' : 'stickers'; if (!state.expressions[key].some((item) => item.id === expression.id)) state.expressions[key].push(expression); if (!$('#emoji-popover').hidden) renderExpressionPicker(); renderMessages().catch(() => {}) })
  api.subscribe('expression.deleted', ({ serverId, expressionId }) => { if (serverId !== state.serverId) return; state.expressions.emojis = state.expressions.emojis.filter((item) => item.id !== expressionId); state.expressions.stickers = state.expressions.stickers.filter((item) => item.id !== expressionId); if (!$('#emoji-popover').hidden) renderExpressionPicker(); renderMessages().catch(() => {}) })
  api.subscribe('ai.reply.failed', (event) => { if (event.channelId === state.channelId) toast(event.reason || 'AI 暂时无法回复') })
  api.subscribe('ai.voice.failed', (event) => { if (event.channelId === state.channelId) toast(event.reason || '语音生成失败，已发送文字回复') })
  api.subscribe('message.updated', (message) => { if (message.channelId === state.channelId) refreshMessageInPlace(message.id) })
  api.subscribe('channel.created', () => renderChannels())
  window.addEventListener('echo:ai-agents-updated', () => { if (state.serverId) renderMembers().catch((error) => console.warn('Could not refresh mention roster', error)) })

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
