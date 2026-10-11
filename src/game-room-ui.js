(() => {
  const api = window.EchoApi
  const app = window.EchoApp
  const $ = selector => document.querySelector(selector)
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`
  const state = { rooms: [], room: null, viewing: false, invite: null, epoch: 0, busy: false, focusBeforeDialog: null, network: null, slotKey: null }
  const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element }
  const joined = () => Boolean(state.room?.currentMemberId)
  const sameVoice = room => { const voice = app.voiceState(); return voice.joined && (voice.roomId === room.id || voice.channelId === room.voiceRoomId) }
  const displayError = error => app.toast(error.message || '操作失败，请重试')
  function showGame() { state.viewing = true; app.showGame() }
  function renderList() {
    $('#room-nav-count').textContent = state.rooms.length
    $('#room-list-count').textContent = `${state.rooms.length} 个房间`
    $('#room-nav-hint').hidden = state.rooms.length > 0
    $('#room-empty').hidden = state.rooms.length > 0
    $('#room-list').replaceChildren(); $('#room-nav-list').replaceChildren()
    for (const room of state.rooms) {
      const nav = document.createElement('button'); nav.className = `channel-row game-nav-row${state.room?.id === room.id && state.viewing ? ' selected' : ''}`
      nav.innerHTML = `${icon('game')}<span class="channel-name"></span><span class="voice-count"></span>`
      nav.querySelector('.channel-name').textContent = room.title; nav.querySelector('.voice-count').textContent = room.members.length
      nav.addEventListener('click', () => openRoom(room.id)); $('#room-nav-list').append(nav)
      const row = document.createElement('button'); row.className = 'room-list-row'
      row.innerHTML = `${icon('game')}<div class="room-list-copy"></div><div class="room-list-people"></div>${icon('chevron-right')}`
      row.querySelector('.room-list-copy').append(text('strong', room.title), text('span', `魔兽争霸 III · 1.24e · ${room.mapName || '地图待定'}`))
      const people = row.querySelector('.room-list-people')
      room.members.slice(0,3).forEach(member => { const avatar = text('span', member.displayName.slice(0,1), 'mini-avatar blue'); avatar.title = member.displayName; people.append(avatar) })
      people.append(text('small', `${room.members.length} 人 · ${api.hasGameSession(room.id) ? '已加入' : '组队中'}`))
      row.addEventListener('click', () => openRoom(room.id)); $('#room-list').append(row)
    }
    $('#browse-game-rooms').classList.toggle('selected', state.viewing && !state.room)
  }
  async function refreshList() {
    state.rooms = await api.listGameRooms(app.getSquadId()); renderList()
  }
  function showOverview() {
    state.epoch++; state.room = null; showGame()
    $('#room-overview').hidden = false; $('#room-detail').hidden = true
    $('#game-page-title').textContent = '开黑房间'; $('#game-page-subtitle').textContent = '小队的游戏时间'
    $('#room-back').hidden = true; $('#room-invite').hidden = true; $('#room-create-header').hidden = false
    renderList(); refreshList().catch(displayError)
  }
  function renderVoice() {
    $('#start-game-from-voice').hidden = !app.voiceState().joined || !app.voiceState().channelId || Boolean(app.voiceState().roomId)
    if (!state.room) return
    const connected = sameVoice(state.room)
    $('#room-voice-state').textContent = connected ? (api.mode === 'mock' ? '已加入房间 · 语音演示' : '已加入房间 · 语音已连接') : '已加入房间 · 尚未连接语音'
    $('#room-voice-toggle span').textContent = connected ? '断开语音' : '连接语音'
    $('#room-voice-toggle').classList.toggle('voice-active', connected)
    const voice = app.voiceState()
    $('#room-join-description').textContent = voice.joined && !connected ? '连接房间语音会离开你当前的语音通话。' : '加入房间后即可聊天，也可以一起连接语音。'
  }
  function renderDetail() {
    const room = state.room; if (!room) return
    const member = joined(); const host = room.members.find(person => person.id === room.hostMemberId)
    $('#room-overview').hidden = true; $('#room-detail').hidden = false
    $('#game-page-title').textContent = room.title; $('#game-page-subtitle').textContent = '开黑房间'
    $('#session-title').textContent = room.title; $('#session-map').textContent = room.mapName || '地图待定'; $('#session-host').textContent = `房主：${host?.displayName || '好友'}`
    $('#session-status').textContent = room.status === 'in_game' ? '游戏进行中' : '组队中'
    $('#room-back').hidden = false; $('#room-create-header').hidden = true; $('#room-invite').hidden = room.role !== 'host'
    $('#room-entry').hidden = member; $('#room-membership').hidden = !member
    $('#room-leave').hidden = !member; $('#room-end').hidden = room.role !== 'host'
    $('#game-member-count').textContent = `房间成员 — ${room.members.length}/8`
    renderSlots()
    $('#game-message-input').disabled = !member; $('#game-message-form button').disabled = !member
    $('#game-message-input').placeholder = member ? `发送消息到 ${room.title}` : '加入房间后即可聊天'
    renderVoice(); renderList()
    window.dispatchEvent(new CustomEvent('echo:room-context', { detail: { id: room.id, joined: member, role: room.role } }))
  }
  function renderSlots() {
    const room = state.room; if (!room) return
    const network = state.network?.roomId === room.id ? state.network : null
    const peers = network && !['idle', 'error', 'connecting'].includes(network.phase) ? network.peerNetwork || [] : []
    const hostRtt = peers.find(peer => peer.memberId === room.hostMemberId)?.rttMs
    const key = JSON.stringify([room.id, room.members, room.currentMemberId, network?.phase, peers.map(p => [p.memberId, p.rttMs, p.jitterMs, p.missedPongs])])
    if (state.slotKey === key) return
    state.slotKey = key
    const target = $('#game-member-list')
    const focusedMember = document.activeElement?.closest?.('.room-slot')?.dataset.memberId
    const expanded = new Set([...target.querySelectorAll('details[open]')].map(node => node.dataset.memberId))
    target.replaceChildren()
    $('#room-network-count').textContent = network ? `${peers.length}/${room.members.length} 人已连接中转` : '等待客户端网络状态'
    for (let i = 0; i < 8; i++) {
      const person = room.members[i]
      if (!person) {
        const slot = document.createElement('div'); slot.className = 'room-slot empty'
        slot.innerHTML = `${icon('plus')}<strong>等待好友加入</strong>`
        slot.append(text('span', `空闲槽位 ${i + 1}`)); target.append(slot); continue
      }
      const peer = peers.find(item => item.memberId === person.id)
      const own = person.id === room.currentMemberId
      const card = document.createElement('details'); card.className = 'room-slot room-person'; card.dataset.memberId = person.id; card.open = expanded.has(person.id)
      const head = document.createElement('summary')
      head.append(text('span', String(i + 1).padStart(2, '0'), 'slot-number'), text('div', person.displayName.slice(0,1), 'avatar blue'))
      const copy = document.createElement('div'); copy.className = 'room-person-copy'
      copy.append(text('strong', `${person.displayName}${own ? ' · 你' : ''}`), text('span', person.role === 'host' ? '房主' : '房间成员'))
      head.append(copy)
      const rtt = peer?.rttMs
      const label = peer ? (Number.isFinite(rtt) ? `${rtt} ms` : '测量中') : own && network?.phase === 'error' ? '连接失败' : own && network?.phase === 'connecting' ? '连接中' : '尚无数据'
      head.append(text('span', label, `slot-network ${Number.isFinite(rtt) ? rtt > 200 ? 'slow' : 'good' : ''}`))
      const info = document.createElement('div'); info.className = 'slot-network-detail'
      info.append(text('strong', '网络详情'), text('p', peer ? `到中转 RTT：${rtt ?? '测量中'}${rtt == null ? '' : ' ms'} · 抖动：${peer.jitterMs ?? '—'} ms · 心跳超时：${peer.missedPongs ?? 0}` : '尚未收到此成员的联机数据。请在 Windows 客户端加入房间。'))
      if (person.role !== 'host' && Number.isFinite(rtt) && Number.isFinite(hostRtt)) info.append(text('p', `与房主往返估算：${hostRtt + rtt} ms（非游戏实测）`))
      card.append(head, info); target.append(card)
      if (person.id === focusedMember) head.focus({ preventScroll: true })
    }
  }
  window.addEventListener('echo:relay-status', event => { state.network = event.detail; renderSlots() })
  async function renderMessages() {
    const room = state.room; if (!room) return
    const target = $('#game-messages')
    if (!joined()) { target.replaceChildren(text('p', '加入房间，与好友聊聊这一局。', 'room-chat-empty')); return }
    const messages = await api.getGameMessages(room.id)
    if (state.room?.id !== room.id || !joined()) return
    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 60
    target.replaceChildren()
    if (!messages.length) target.append(text('p', '房间已就绪。聊聊地图，等好友集合。', 'room-chat-empty'))
    for (const message of messages) {
      const row = document.createElement('div'); row.className = message.kind === 'system' ? 'room-system-message' : 'room-chat-message'
      if (message.kind === 'system') { row.innerHTML = icon('users'); row.append(text('span', message.content)) }
      else {
        row.append(text('div', message.author.slice(0,1), 'avatar blue'))
        const body = document.createElement('div'); const meta = document.createElement('div'); meta.className = 'room-message-meta'
        meta.append(text('strong', message.author), text('time', new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))))
        body.append(meta, text('p', message.content)); row.append(body)
      }
      target.append(row)
    }
    if (atBottom) target.scrollTop = target.scrollHeight
  }
  async function openRoom(id, inviteCode, stayOnPage = false) {
    const epoch = ++state.epoch
    try {
      let room
      if (api.hasGameSession(id)) {
        try { room = await api.getGameRoom(id) }
        catch (error) { if (error.status !== 403) throw error; api.forgetGameSession(id) }
      }
      if (!room) room = await api.previewGameRoom(id, inviteCode)
      if (epoch !== state.epoch) return
      if (state.room?.id !== id) $('#game-message-input').value = ''
      state.room = room
      if (inviteCode) state.invite = { id, code: inviteCode }
      if (!stayOnPage) showGame()
      renderDetail(); await renderMessages()
    } catch (error) {
      if (epoch !== state.epoch) return
      if ([403,404].includes(error.status)) { window.dispatchEvent(new CustomEvent('echo:room-left', { detail: id })); api.forgetGameSession(id); if (app.isGameRoomVoice(id)) await app.disconnectVoice(); showOverview() }
      displayError(error)
    }
  }
  async function confirmAction(title, copy) {
    const dialog = $('#room-confirm'); $('#room-confirm-title').textContent = title; $('#room-confirm-copy').textContent = copy
    dialog.returnValue = 'cancel'; dialog.showModal()
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }))
  }
  async function connectRoomVoice() {
    const room = state.room; if (!room) return
    const voice = app.voiceState()
    if (voice.joined && !sameVoice(room) && !await confirmAction('切换语音房间？', `将离开当前通话，连接到「${room.title}」。`)) return
    await app.joinGameVoice(room); renderVoice()
  }
  async function joinRoom(withVoice) {
    if (state.busy || !state.room) return
    state.busy = true; $('#room-join-text').disabled = true; $('#room-join-voice').disabled = true
    const id = state.room.id
    try {
      const active = api.getActiveGameRoomId()
      if (active && active !== id && api.hasGameSession(active)) {
        if (!await confirmAction('切换开黑房间？', '你将离开之前加入的房间；如果你是房主，会把房主转交给其他成员。')) return
        await api.leaveGameRoom(active)
        window.dispatchEvent(new CustomEvent('echo:room-left', { detail: active }))
        if (app.isGameRoomVoice(active)) await app.disconnectVoice()
      }
      const room = await api.joinGameRoom(id, state.invite?.id === id ? state.invite.code : undefined, app.getUser().displayName)
      state.room = room; renderDetail(); await renderMessages(); await refreshList()
      if (withVoice) await connectRoomVoice()
    } catch (error) { displayError(error) }
    finally { state.busy = false; $('#room-join-text').disabled = false; $('#room-join-voice').disabled = false }
  }
  function closeCreate() { $('#game-room-overlay').hidden = true; state.focusBeforeDialog?.focus() }
  async function openCreate() {
    const active = api.getActiveGameRoomId()
    if (active && api.hasGameSession(active)) { await openRoom(active); app.toast('你已经加入一个房间，离开后即可创建新房间。'); return }
    state.focusBeforeDialog = document.activeElement
    $('#game-room-name').value = `${app.getUser().displayName} 的开黑房间`
    $('#game-room-map').value = localStorage.getItem('echo.last-map') || ''
    $('#room-keep-voice-label').hidden = !app.voiceState().joined || !app.voiceState().channelId
    $('#room-keep-voice').checked = true; $('#room-create-error').hidden = true
    $('#game-room-overlay').hidden = false; $('#game-room-name').focus(); $('#game-room-name').select()
  }
  $('#create-game-room-form').addEventListener('submit', async event => {
    event.preventDefault(); const submit = event.submitter; submit.disabled = true
    try {
      const title = $('#game-room-name').value.trim(); if (!title) throw new Error('请填写房间名称')
      const voice = app.voiceState(); const voiceChannelId = $('#room-keep-voice').checked && voice.joined ? voice.channelId : null
      const room = await api.createGameRoom(app.getSquadId(), { title, mapName: $('#game-room-map').value.trim(), displayName: app.getUser().displayName, voiceChannelId })
      localStorage.setItem('echo.last-map', room.mapName); closeCreate(); state.room = room; showGame(); app.adoptGameVoice(room); renderDetail(); await renderMessages(); await refreshList()
    } catch (error) { $('#room-create-error').textContent = error.message; $('#room-create-error').hidden = false }
    finally { submit.disabled = false }
  })
  for (const id of ['create-game-room','room-create-header','room-create-empty','start-game-from-voice']) $(`#${id}`).addEventListener('click', () => openCreate().catch(displayError))
  for (const id of ['close-game-room','cancel-game-room']) $(`#${id}`).addEventListener('click', closeCreate)
  $('#game-room-overlay').addEventListener('click', event => { if (event.target === event.currentTarget) closeCreate() })
  $('#game-room-overlay').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeCreate() }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll('button,input')].filter(node => !node.disabled && node.getClientRects().length)
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  })
  $('#browse-game-rooms').addEventListener('click', showOverview); $('#room-back').addEventListener('click', showOverview)
  $('#refresh-game-room').addEventListener('click', () => { refreshList().catch(displayError); if (state.room) openRoom(state.room.id, state.invite?.code) })
  $('#room-join-text').addEventListener('click', () => joinRoom(false)); $('#room-join-voice').addEventListener('click', () => joinRoom(true))
  $('#room-voice-toggle').addEventListener('click', async () => { const button = $('#room-voice-toggle'); button.disabled = true; try { if (sameVoice(state.room)) await app.disconnectVoice(); else await connectRoomVoice() } catch (error) { displayError(error) } finally { button.disabled = false; renderVoice() } })
  for (const [id, endRoom] of [['room-leave',false],['room-end',true]]) $(`#${id}`).addEventListener('click', async () => {
    if (state.busy || !state.room) return
    const room = state.room
    if (!await confirmAction(endRoom ? '结束这个房间？' : '离开这个房间？', endRoom ? '所有成员将退出房间，房间会从列表中移除。' : room.role === 'host' ? '有其他成员时会自动转交房主；最后一人离开后，房间结束。' : '你会退出房间及关联语音，随时可以重新加入。')) return
    state.busy = true
    try { await api.leaveGameRoom(room.id, endRoom); window.dispatchEvent(new CustomEvent('echo:room-left', { detail: room.id })); if (sameVoice(room)) await app.disconnectVoice(); showOverview() }
    catch (error) { displayError(error) } finally { state.busy = false }
  })
  $('#room-invite').addEventListener('click', async () => {
    try {
      const room = state.room; let code = api.getGameInviteCode(room.id)
      if (!code || new Date(room.inviteExpiresAt) < new Date()) code = await api.createGameInvite(room.id)
      const url = new URL(window.EchoDesktop ? window.EchoServerUrl + '/' : location.href); url.search = ''; url.hash = new URLSearchParams({ war3: room.id, invite: code }).toString()
      $('#room-invite-link').value = url.toString(); $('#room-invite-feedback').textContent = '链接有效期 7 天。'; $('#room-invite-dialog').showModal()
    } catch (error) { displayError(error) }
  })
  $('#copy-room-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#room-invite-link').value); $('#room-invite-feedback').textContent = '链接已复制。' } catch { $('#room-invite-link').select(); $('#room-invite-feedback').textContent = '请使用 Ctrl+C 复制链接。' } })
  $('#game-message-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!joined()) return
    const input = $('#game-message-input'); const content = input.value.trim(); if (!content) return
    const id = state.room.id; const button = $('#game-message-form button'); button.disabled = true
    try { await api.sendGameMessage(id, content); if (state.room?.id === id && input.value.trim() === content) input.value = ''; await renderMessages() } catch (error) { displayError(error) } finally { button.disabled = !joined() }
  })
  $('#game-message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#game-message-form button').disabled) $('#game-message-form').requestSubmit() } })
  window.addEventListener('echo:chat-view', () => { state.viewing = false; state.epoch++; renderList() })
  window.addEventListener('echo:voice-state', renderVoice)
  window.addEventListener('echo:voice-speakers', event => {
    $('#game-member-list').querySelectorAll('.room-person').forEach(row => {
      const localLobbySpeaker = row.dataset.memberId === state.room?.currentMemberId && event.detail.includes(app.getUser()?.id)
      row.classList.toggle('speaking', event.detail.includes(row.dataset.memberId) || localLobbySpeaker)
    })
  })
  api.subscribe('game-room.message', ({ roomId }) => { if (state.room?.id === roomId && joined()) renderMessages().catch(displayError) })
  api.subscribe('game-room.updated', async ({ roomId }) => {
    try {
      await refreshList()
      if (!state.rooms.some(room => room.id === roomId) && api.hasGameSession(roomId)) { api.forgetGameSession(roomId); window.dispatchEvent(new CustomEvent('echo:room-left', { detail: roomId })); if (app.isGameRoomVoice(roomId)) await app.disconnectVoice(); if (state.room?.id === roomId && state.viewing) { showOverview(); app.toast('房间已结束') } }
      else if (state.room?.id === roomId && !state.busy) await openRoom(roomId, state.invite?.code, true)
    } catch (error) { displayError(error) }
  })
  api.subscribe('connection.restored', () => { if (app.getSquadId()) { refreshList().catch(displayError); if (state.room && state.viewing) openRoom(state.room.id, state.invite?.code, true) } })
  async function start() {
    await window.EchoAppReady; await refreshList()
    const params = new URLSearchParams(location.hash.slice(1) || location.search)
    if (params.get('war3')) { const id = params.get('war3'); const code = params.get('invite'); history.replaceState({}, '', location.pathname); await openRoom(id, code) }
    else { const active = api.getActiveGameRoomId(); if (active && !state.rooms.some(room => room.id === active)) api.forgetGameSession(active); else if (active) await openRoom(active) }
  }
  start().catch(displayError)
})()
