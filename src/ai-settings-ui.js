(() => {
  const api = window.EchoApi
  const $ = (selector) => document.querySelector(selector)
  const form = $('#ai-create-form')
  if (!api || !$('#settings-ai-tab')) return
  let serverId = null
  let agents = []
  let channels = []
  let canManage = false
  let canCreate = false
  let stickerManage = false
  let stickerAdmin = false
  let ttsConfig = { configured: false, canManage: false }
  let activeAgentId = null
  let loading = false
  let stickerObjectUrls = []

  function feedback(selector, message, error = false) {
    const node = $(selector); node.textContent = message; node.classList.toggle('is-error', error)
  }
  function tab(name) {
    $('#audio-settings-body').hidden = name !== 'audio'
    $('#game-settings-body').hidden = name !== 'game'
    $('#ai-settings-body').hidden = name !== 'ai'
    $('#settings-audio-tab').classList.toggle('selected', name === 'audio')
    $('#settings-game-tab').classList.toggle('selected', name === 'game')
    $('#settings-ai-tab').classList.toggle('selected', name === 'ai')
    $('.settings-topbar > span').textContent = name === 'ai' ? 'AI 机器人' : name === 'game' ? '游戏与启动' : '语音和视频'
    $('.audio-settings-dialog').setAttribute('aria-labelledby', name === 'ai' ? 'settings-ai-tab' : name === 'game' ? 'settings-game-tab' : 'audio-settings-title')
    if (name === 'ai') load().catch((error) => feedback('#ai-settings-feedback', error.message || '无法读取机器人配置', true))
  }
  function currentAgent() { return agents.find((agent) => agent.id === activeAgentId) }

  function renderAgentSelect() {
    const select = $('#ai-agent-select')
    select.replaceChildren()
    for (const agent of agents) {
      const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; select.append(option)
    }
    if (!agents.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '尚无机器人'; select.append(option) }
    select.value = activeAgentId || agents[0]?.id || ''
  }

  function renderAgent() {
    const agent = currentAgent()
    const canManageAgent = Boolean(agent && (canManage || agent.canManage))
    renderAgentSelect()
    const agentControls = ['#ai-agent-name', '#ai-agent-description', '#ai-agent-persona', '#ai-agent-model', '#ai-agent-temperature', '#ai-agent-max-tokens', '#ai-agent-enabled', '#ai-image-understanding', '#ai-web-search', '#ai-sticker-sending', '#ai-voice-replies', '#ai-agent-save', '#ai-trigger-mode', '#ai-cooldown']
    for (const selector of agentControls) $(selector).disabled = !canManageAgent
    for (const selector of ['#ai-provider-key', '#ai-provider-save', '#ai-provider-test']) $(selector).disabled = !agent || !canManage
    $('#ai-agent-create').disabled = !canCreate
    $('#ai-agent-name').value = agent?.name || ''
    $('#ai-agent-description').value = agent?.description || ''
    $('#ai-agent-persona').value = agent?.persona || ''
    $('#ai-agent-model').value = agent?.model || 'deepseek-flash'
    $('#ai-agent-temperature').value = String(agent?.temperature ?? 0.8)
    $('#ai-temperature-value').textContent = String(agent?.temperature ?? 0.8)
    $('#ai-agent-max-tokens').value = String(agent?.maxOutputTokens ?? 700)
    $('#ai-agent-enabled').checked = agent?.enabled !== false
    $('#ai-image-understanding').checked = agent?.imageUnderstandingEnabled === true
    $('#ai-web-search').checked = agent?.webSearchEnabled === true
    $('#ai-sticker-sending').checked = agent?.stickerSendingEnabled !== false
    $('#ai-voice-replies').checked = agent?.voiceRepliesEnabled === true
    $('#ai-provider-key').value = ''
    $('#ai-provider-state').textContent = agent?.providerConfigured ? `已配置 ·•••• ${agent.keySuffix || '••••'}` : '尚未配置 API Key'
    feedback('#ai-provider-feedback', '')
    feedback('#ai-settings-feedback', !canManageAgent ? '你可以查看机器人设置；只有创建者或小队管理员可以修改。' : (!canManage ? '共享 DeepSeek API Key 仅由小队管理员管理。' : ''))
    $('#ai-settings-feedback').classList.toggle('is-error', !canManageAgent)
    $('#ai-voice-replies').title = agent?.voiceRepliesEnabled && !ttsConfig.configured ? 'TTS 服务尚未配置，机器人会暂时只发送文字' : ''

    const installationByChannel = new Map((agent?.installations || []).map((entry) => [entry.channelId, entry]))
    const list = $('#ai-channel-list'); list.replaceChildren()
    const textChannels = channels.filter((channel) => channel.type === 'text')
    for (const channel of textChannels) {
      const setting = installationByChannel.get(channel.id)
      const label = document.createElement('label'); label.className = 'ai-channel-option'
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.channelId = channel.id; checkbox.checked = setting?.enabled ?? false; checkbox.disabled = !canManageAgent
      const name = document.createElement('span'); name.textContent = `# ${channel.name}`
      label.append(checkbox, name); list.append(label)
    }
    const firstSetting = (agent?.installations || []).find((entry) => entry.enabled)
    $('#ai-trigger-mode').value = firstSetting?.triggerMode || 'mention'
    $('#ai-cooldown').value = String(firstSetting?.cooldownSeconds ?? 15)
  }

  function renderTtsConfig() {
    const canEdit = Boolean(ttsConfig.canManage)
    const provider = ttsConfig.provider || $('#ai-tts-provider').value || 'doubao'
    $('#ai-tts-provider').value = provider
    $('#ai-tts-base-url').value = ttsConfig.baseUrl || ''
    $('#ai-tts-model').value = ttsConfig.model || ''
    $('#ai-tts-voice').value = ttsConfig.voice || ''
    $('#ai-tts-resource-id').value = ttsConfig.resourceId || 'seed-tts-2.0'
    const doubao = provider === 'doubao'
    $('#ai-tts-base-url-field').hidden = doubao
    $('#ai-tts-resource-field').hidden = !doubao
    $('#ai-tts-model').placeholder = doubao ? 'seed-tts-2.0-standard' : '服务商提供的 TTS 模型名'
    $('#ai-tts-voice-label').textContent = doubao ? '音色 ID（speaker）' : '音色（voice）'
    $('#ai-tts-voice').placeholder = doubao ? '从豆包控制台音色库复制' : '服务商提供的 voice 名称'
    $('#ai-tts-key').value = ''
    $('#ai-tts-state').textContent = ttsConfig.configured ? `已配置 ·•••• ${ttsConfig.keySuffix || '••••'}` : '尚未配置'
    for (const selector of ['#ai-tts-provider', '#ai-tts-base-url', '#ai-tts-model', '#ai-tts-voice', '#ai-tts-resource-id', '#ai-tts-key', '#ai-tts-save', '#ai-tts-test']) $(selector).disabled = !canEdit
    $('#ai-tts-test').disabled = !canEdit || !ttsConfig.configured
    feedback('#ai-tts-feedback', canEdit ? '' : '只有小队管理员可以配置共享语音服务。')
  }

  async function load() {
    if (loading) return
    loading = true
    try {
      const servers = await api.getServers()
      serverId = servers[0]?.id
      if (!serverId) throw new Error('当前账号没有可访问的小队')
      const [result, channelRows, ttsResult] = await Promise.all([api.getAiAgents(serverId), api.getChannels(serverId), api.getAiTtsConfig(serverId)])
      agents = result.agents || []; channels = channelRows; canManage = Boolean(result.canManage); canCreate = Boolean(result.canCreate)
      ttsConfig = ttsResult || { configured: false, canManage: false }; renderTtsConfig()
      if (!agents.some((agent) => agent.id === activeAgentId)) activeAgentId = agents[0]?.id || null
      renderAgent()
      await renderStickerLibrary()
    } finally { loading = false }
  }

  async function renderStickerLibrary() {
    stickerObjectUrls.forEach((url) => URL.revokeObjectURL(url)); stickerObjectUrls = []
    const node = $('#ai-sticker-library'); node.replaceChildren()
    const agent = currentAgent()
    $('#ai-sticker-scope').disabled = !agent || !stickerManage
    $('#ai-sticker-scope').querySelector('option[value="system"]').disabled = !stickerAdmin
    $('#ai-sticker-upload').disabled = !agent || !stickerManage
    if (!agent) { node.textContent = '先创建一个机器人。'; return }
    try {
      const result = await api.getAiStickers(agent.id)
      stickerManage = Boolean(result.canManage); stickerAdmin = Boolean(result.canManageSystem)
      $('#ai-sticker-scope').disabled = !stickerManage; $('#ai-sticker-scope').querySelector('option[value="system"]').disabled = !stickerAdmin; $('#ai-sticker-upload').disabled = !stickerManage
      const stickers = result.stickers || []
      if (!stickers.length) { node.textContent = '系统图库还没有表情。上传到系统的资源会提供给所有机器人使用。'; return }
      const sections = new Map()
      for (const sticker of stickers) { const key = `${sticker.scope}:${sticker.groupName}`; if (!sections.has(key)) sections.set(key, { scope: sticker.scope, name: sticker.groupName || '未分组', stickers: [] }); sections.get(key).stickers.push(sticker) }
      for (const sectionData of sections.values()) {
        const section = document.createElement('section'); section.className = 'ai-sticker-group'
        const heading = document.createElement('h3'); heading.textContent = `${sectionData.scope === 'system' ? '系统默认' : '当前机器人'} · ${sectionData.name}`; const grid = document.createElement('div'); grid.className = 'ai-sticker-grid'
        for (const sticker of sectionData.stickers) {
          const card = document.createElement('article'); card.className = 'ai-sticker-card'
          const image = document.createElement('img'); image.alt = sticker.name; image.loading = 'lazy'; card.append(image)
          api.getAiStickerBlob(sticker.id).then((blob) => { if (!card.isConnected) return; const url = URL.createObjectURL(blob); stickerObjectUrls.push(url); image.src = url }).catch(() => { image.alt = `${sticker.name}（预览加载失败）` })
          const name = document.createElement('strong'); name.textContent = sticker.name; const description = document.createElement('span'); description.textContent = sticker.description || '未填写选图说明'; card.append(name, description)
          if (stickerManage && (sticker.scope !== 'system' || stickerAdmin)) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'expression-group-action danger ai-sticker-remove'; remove.title = '下架表情'; remove.setAttribute('aria-label', `下架 ${sticker.name}`); remove.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>'; remove.addEventListener('click', async () => { try { await api.deleteAiSticker(agent.id, sticker.id); await renderStickerLibrary(); feedback('#ai-sticker-feedback', '表情已下架。') } catch (error) { feedback('#ai-sticker-feedback', error.message || '下架失败', true) } }); card.append(remove) }
          grid.append(card)
        }
        section.append(heading, grid); node.append(section)
      }
    } catch (error) { node.textContent = error.message || '无法加载机器人图库。' }
  }

  $('#settings-ai-tab').addEventListener('click', () => tab('ai'))
  $('#settings-audio-tab').addEventListener('click', () => tab('audio'))
  $('#settings-game-tab').addEventListener('click', () => tab('game'))
  $('#ai-agent-select').addEventListener('change', () => { activeAgentId = $('#ai-agent-select').value; renderAgent(); renderStickerLibrary() })
  $('#ai-sticker-upload').addEventListener('click', () => $('#ai-sticker-file').click())
  $('#ai-sticker-file').addEventListener('change', (event) => {
    const files = [...event.currentTarget.files]; event.currentTarget.value = ''; const agent = currentAgent(); if (!files.length || !agent) return
    const scope = $('#ai-sticker-scope').value
    window.EchoStickerUpload.open({ title: '批量上传机器人表情', subtitle: `${scope === 'system' ? '系统默认图库' : '当前机器人专属图库'} · 每张图片可单独维护名称、情绪和选图说明。`, files, nameLabel: '表情名称', nameMax: 40, metaLabel: '情绪分组', metaMode: 'text', metaRequired: true, defaultMeta: '卖萌', description: true, maxSize: 2 * 1024 * 1024, onUpload: ({ file, name, meta, description }) => api.uploadAiSticker(agent.id, file, name, meta, description, scope), onComplete: async ({ succeeded }) => { if (!succeeded) return; await renderStickerLibrary(); feedback('#ai-sticker-feedback', `已加入图库 ${succeeded} 张表情。`) } })
  })
  $('#ai-agent-temperature').addEventListener('input', () => { $('#ai-temperature-value').textContent = $('#ai-agent-temperature').value })
  $('#ai-agent-create').addEventListener('click', () => { form.hidden = false; $('#ai-create-name').focus() })
  $('#ai-create-cancel').addEventListener('click', () => { form.hidden = true })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!canCreate || !serverId) return
    const button = form.querySelector('[type=submit]'); button.disabled = true
    try {
      const { agent } = await api.createAiAgent(serverId, { name: $('#ai-create-name').value, description: $('#ai-create-description').value, persona: $('#ai-create-persona').value })
      form.reset(); form.hidden = true; activeAgentId = agent.id; await load(); window.dispatchEvent(new Event('echo:ai-agents-updated')); feedback('#ai-settings-feedback', '机器人已创建。')
    } catch (error) { feedback('#ai-settings-feedback', error.message || '创建机器人失败', true) }
    finally { button.disabled = false }
  })

  $('#ai-agent-save').addEventListener('click', async () => {
    const agent = currentAgent(); if (!agent) return
    const button = $('#ai-agent-save'); button.disabled = true; feedback('#ai-settings-feedback', '正在保存…')
    const triggerMode = $('#ai-trigger-mode').value
    const cooldownSeconds = Number($('#ai-cooldown').value)
    const channelSettings = [...$('#ai-channel-list').querySelectorAll('[data-channel-id]')].map((checkbox) => ({ channelId: checkbox.dataset.channelId, enabled: checkbox.checked, triggerMode, cooldownSeconds }))
    try {
      const { agent: updated } = await api.updateAiAgent(agent.id, { name: $('#ai-agent-name').value, description: $('#ai-agent-description').value, persona: $('#ai-agent-persona').value, model: $('#ai-agent-model').value, temperature: Number($('#ai-agent-temperature').value), maxOutputTokens: Number($('#ai-agent-max-tokens').value), enabled: $('#ai-agent-enabled').checked, voiceRepliesEnabled: $('#ai-voice-replies').checked })
      await api.updateAiInstallations(agent.id, channelSettings)
      const enabledTools = [$('#ai-image-understanding').checked && 'image.read', $('#ai-web-search').checked && 'web.search', $('#ai-sticker-sending').checked && 'sticker.send'].filter(Boolean).map((key) => ({ key }))
      await api.updateAiTools(agent.id, enabledTools)
      agents = agents.map((item) => item.id === updated.id ? { ...item, ...updated, imageUnderstandingEnabled: $('#ai-image-understanding').checked, webSearchEnabled: $('#ai-web-search').checked, stickerSendingEnabled: $('#ai-sticker-sending').checked, voiceRepliesEnabled: $('#ai-voice-replies').checked, installations: channelSettings } : item)
      window.dispatchEvent(new Event('echo:ai-agents-updated'))
      renderAgent(); feedback('#ai-settings-feedback', '机器人设置已保存。')
    } catch (error) { feedback('#ai-settings-feedback', error.message || '保存机器人设置失败', true) }
    finally { button.disabled = !(canManage || currentAgent()?.canManage) }
  })

  $('#ai-provider-save').addEventListener('click', async () => {
    const agent = currentAgent(); const apiKey = $('#ai-provider-key').value.trim()
    if (!agent || !apiKey) return feedback('#ai-provider-feedback', '请先粘贴 API Key。', true)
    const button = $('#ai-provider-save'); button.disabled = true; feedback('#ai-provider-feedback', '正在加密保存…')
    try {
      const result = await api.saveAiProvider(agent.id, { provider: 'deepseek', apiKey })
      $('#ai-provider-key').value = ''; agent.providerConfigured = true; agent.keySuffix = result.keySuffix
      $('#ai-provider-state').textContent = `已配置 ·•••• ${result.keySuffix}`
      feedback('#ai-provider-feedback', 'API Key 已加密保存。')
    } catch (error) { feedback('#ai-provider-feedback', error.message || '保存 API Key 失败', true) }
    finally { button.disabled = !canManage }
  })

  $('#ai-provider-test').addEventListener('click', async () => {
    const agent = currentAgent(); if (!agent) return
    const button = $('#ai-provider-test'); button.disabled = true; feedback('#ai-provider-feedback', '正在测试 DeepSeek 连接…')
    try {
      const result = await api.testAiProvider(agent.id)
      const models = result.availableModels?.length ? ` · 可用模型：${result.availableModels.join('、')}` : ''
      feedback('#ai-provider-feedback', result.mock ? `Mock 演示：模拟连接成功，${result.latencyMs} ms${models}` : `连接成功，${result.latencyMs} ms${models}`)
    } catch (error) { feedback('#ai-provider-feedback', error.message || '连接测试失败', true) }
    finally { button.disabled = !canManage }
  })

  $('#ai-tts-save').addEventListener('click', async () => {
    if (!serverId || !ttsConfig.canManage) return
    const button = $('#ai-tts-save'); button.disabled = true; feedback('#ai-tts-feedback', '正在加密保存语音服务配置…')
    try {
      const result = await api.saveAiTtsConfig(serverId, { provider: $('#ai-tts-provider').value, baseUrl: $('#ai-tts-base-url').value.trim(), model: $('#ai-tts-model').value.trim(), voice: $('#ai-tts-voice').value.trim(), resourceId: $('#ai-tts-resource-id').value.trim(), apiKey: $('#ai-tts-key').value.trim() })
      ttsConfig = { ...ttsConfig, ...result }; $('#ai-tts-key').value = ''; renderTtsConfig(); feedback('#ai-tts-feedback', '语音合成服务配置已保存。')
    } catch (error) { feedback('#ai-tts-feedback', error.message || '保存语音合成配置失败', true) }
    finally { button.disabled = !ttsConfig.canManage }
  })
  $('#ai-tts-provider').addEventListener('change', () => {
    ttsConfig = { ...ttsConfig, provider: $('#ai-tts-provider').value }
    renderTtsConfig()
  })
  $('#ai-tts-test').addEventListener('click', async () => {
    if (!serverId || !ttsConfig.canManage || !ttsConfig.configured) return
    const button = $('#ai-tts-test'); button.disabled = true; feedback('#ai-tts-feedback', '正在生成一段测试语音…')
    try { const result = await api.testAiTtsConfig(serverId); feedback('#ai-tts-feedback', `合成成功 · ${result.latencyMs} ms · ${(result.audioBytes / 1024).toFixed(0)} KB`) }
    catch (error) { feedback('#ai-tts-feedback', error.message || 'TTS 测试失败', true) }
    finally { button.disabled = !ttsConfig.canManage || !ttsConfig.configured }
  })

  window.addEventListener('echo:authenticated', () => { agents = []; activeAgentId = null })
})()
