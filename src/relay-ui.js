(() => {
  const invoke = window.__TAURI__?.core?.invoke
  const button = document.querySelector('#relay-toggle'), detail = document.querySelector('#relay-detail'), metrics = document.querySelector('#relay-metrics')
  const diagnosticsPanel = document.querySelector('#relay-diagnostics'), chart = document.querySelector('#relay-rtt-chart')
  const diagnosticsSummary = document.querySelector('#relay-diagnostics-summary'), clientPingSummary = document.querySelector('#relay-client-ping-summary')
  const transportMode = document.querySelector('#relay-transport-mode')
  let room, desiredRoom = null, pausedRoom = null, attemptedKey = null, fallbackKey = null, status = { phase: 'idle' }, busy = false, polling = false, mutationEpoch = 0
  const savedMode = localStorage.getItem('echo-relay-transport-mode')
  if (transportMode) transportMode.value = ['wss', 'quic-compat'].includes(savedMode) ? savedMode : 'auto'
  transportMode?.addEventListener('change', () => localStorage.setItem('echo-relay-transport-mode', transportMode.value))
  const active = () => !['idle','error'].includes(status.phase)
  const diagnostic = (message) => invoke?.('write_client_log', { message: `relay-ui ${message}` }).catch(() => {})
  const quantile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
  function renderDiagnostics(peer) {
    diagnosticsPanel.hidden = !invoke || !active()
    const history = (peer?.rttHistory || []).filter(sample => Number.isFinite(sample.rttMs) && Number.isFinite(sample.at)).slice(-60)
    if (!history.length) {
      chart.innerHTML = '<text class="relay-chart-label" x="16" y="70">正在收集 RTT 样本…</text>'
      diagnosticsSummary.textContent = '连接后约每 5 秒采集一次，统计窗口为最近 5 分钟。'
    } else {
      const startAt = history[0].at, endAt = Math.max(startAt + 1, history[history.length - 1].at)
      const ceiling = Math.max(200, Math.min(5000, Math.ceil(Math.max(...history.map(sample => sample.rttMs)) / 100) * 100))
      const points = history.map(sample => {
        const x = 38 + ((sample.at - startAt) / (endAt - startAt)) * 426
        const y = 108 - (Math.min(sample.rttMs, ceiling) / ceiling) * 82
        return `${x.toFixed(1)},${y.toFixed(1)}`
      }).join(' ')
      const sorted = history.map(sample => sample.rttMs).sort((a, b) => a - b)
      chart.innerHTML = `<line class="relay-chart-grid" x1="38" y1="26" x2="464" y2="26"/><line class="relay-chart-grid" x1="38" y1="67" x2="464" y2="67"/><line class="relay-chart-grid" x1="38" y1="108" x2="464" y2="108"/><text class="relay-chart-label" x="2" y="29">${ceiling} ms</text><text class="relay-chart-label" x="7" y="70">${Math.round(ceiling / 2)} ms</text><text class="relay-chart-label" x="18" y="111">0</text><polyline class="relay-chart-line" points="${points}"/>${history.map(sample => { const x = 38 + ((sample.at - startAt) / (endAt - startAt)) * 426; const y = 108 - (Math.min(sample.rttMs, ceiling) / ceiling) * 82; return `<circle class="relay-chart-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5"/>` }).join('')}`
      const p95 = sorted.length >= 40 ? ` · P95 ${quantile(sorted, 0.95)} ms` : ` · P95 样本不足（${sorted.length}/40）`
      diagnosticsSummary.textContent = `最近 5 分钟 ${sorted.length} 个样本：中位数 ${quantile(sorted, 0.5)} ms · 最低 ${sorted[0]} ms · 峰值 ${sorted[sorted.length - 1]} ms${p95}`
    }
    const processing = (status.clientPingSamples || []).map(sample => sample.processingMs).filter(Number.isFinite).sort((a, b) => a - b)
    clientPingSummary.textContent = processing.length
      ? `本机收到心跳后发出 Pong 的处理耗时：中位数 ${quantile(processing, 0.5).toFixed(2)} ms · 峰值 ${Math.max(...processing).toFixed(2)} ms · ${processing.length} 个样本`
      : '本机心跳处理耗时：等待样本…'
  }
  function render() {
    window.dispatchEvent(new CustomEvent('echo:relay-status', { detail: status }))
    button.disabled = !invoke || busy || (!active() && !room?.joined)
    button.textContent = busy ? '连接处理中…' : active() ? '暂停联机' : status.phase === 'error' ? '重试连接' : '连接联机'
    if (!invoke) return
    detail.textContent = active() || status.phase === 'error' ? status.detail : room?.joined ? '加入房间后自动连接中转。已暂停时，点击连接联机恢复。' : '加入房间后才能开启联机。'
    if (active() && room?.id !== status.roomId) detail.textContent = `另一个房间的联机仍在运行。${status.detail}`
    if (!active()) { metrics.textContent = ''; diagnosticsPanel.hidden = !invoke; return }
    const peerNetwork = status.peerNetwork || []
    const self = peerNetwork.find(peer => peer.isSelf) || peerNetwork.find(peer => peer.role === status.role)
    let guestNumber = 0
    const latency = peerNetwork.map(peer => {
      const role = peer.role === 'host' ? '房主' : `加入者${++guestNumber}`
      const rtt = peer.rttMs == null ? '测量中' : `${peer.rttMs} ms`
      const jitter = peer.jitterMs == null ? '—' : `${peer.jitterMs} ms`
      return `${role}到中转 ${rtt}（抖动 ${jitter}，心跳超时 ${peer.missedPongs}）`
    }).join(' · ')
    const hostRtt = peerNetwork.find(peer => peer.role === 'host')?.rttMs
    guestNumber = 0
    const estimates = peerNetwork.filter(peer => peer.role !== 'host').map(peer => {
      const name = `加入者${++guestNumber}`
      return Number.isFinite(hostRtt) && Number.isFinite(peer.rttMs) ? `${name}约 ${hostRtt + peer.rttMs} ms` : null
    }).filter(Boolean)
    const estimate = estimates.length ? ` · 房主至玩家往返估算 ${estimates.join(' / ')}` : ''
    const transport = status.transport === 'quic' ? 'QUIC/UDP' : status.transport === 'wss' ? (fallbackKey === `${status.roomId}:${status.role}` ? 'WSS/TCP（自动回退）' : 'WSS/TCP') : '连接中'
    metrics.textContent = `${transport} · ${latency || '正在测量到中转延迟'}${estimate} · 中转端点 ${status.peers || 0}/8 · 对局广播 ${status.advertisements || 0} 次 · 发送 ${((status.sentBytes || 0)/1024).toFixed(1)} KB / 接收 ${((status.receivedBytes || 0)/1024).toFixed(1)} KB`
    renderDiagnostics(self)
  }
  async function stopRelay() {
    await invoke('stop_relay')
    // Native stop signals the worker; wait for sockets to close before starting another room.
    for (let i = 0; i < 100; i++) {
      const next = await invoke('relay_status')
      if (['idle', 'error'].includes(next.phase)) { status = next; return }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('上一个联机通道仍在关闭，请稍后重试')
  }
  // Serialize native mutations. A late ticket must never restart a room already left.
  async function reconcile() {
    if (!invoke || busy) return
    const target = desiredRoom
    const key = target ? `${target.id}:${target.role}` : null
    if (target && pausedRoom === target.id) return
    if (target && active() && status.roomId === target.id && status.role === target.role) return
    if (target && attemptedKey === key) return
    if (!target && !active()) return
    busy = true; mutationEpoch++; render()
    try {
      if (active()) await stopRelay()
      if (target) {
        attemptedKey = key
        await diagnostic(`automatic connect room=${target.id} role=${target.role}`)
        status = { phase: 'connecting', roomId: target.id, role: target.role, detail: '正在连接房间网络…' }; render()
        const ticket = await window.EchoApi.getGameRelayTicket(target.id)
        if (desiredRoom?.id !== target.id || desiredRoom?.role !== target.role || pausedRoom === target.id) return
        await invoke('start_relay', { roomId: target.id, ticket: ticket.ticket, transportMode: fallbackKey === key ? 'wss' : transportMode?.value || 'auto' })
        if (desiredRoom?.id !== target.id || desiredRoom?.role !== target.role) await stopRelay()
      }
      status = await invoke('relay_status')
    } catch (error) {
      const message = String(error.message || error)
      await diagnostic(`operation failed room=${target?.id} error=${message}`)
      status = { phase: 'error', roomId: target?.id, role: target?.role, detail: `联机连接失败：${message}。请点击重试连接。` }
      window.EchoApp?.toast(message)
    } finally {
      busy = false; render()
      if (desiredRoom?.id !== target?.id || desiredRoom?.role !== target?.role) reconcile()
    }
  }
  window.addEventListener('echo:room-context', event => {
    room = event.detail
    if (room.joined) { desiredRoom = { ...room, role: room.role === 'host' ? 'host' : 'guest' }; reconcile() }
    render()
  })
  window.addEventListener('echo:room-left', event => {
    if (desiredRoom?.id === event.detail || status.roomId === event.detail) {
      desiredRoom = null; pausedRoom = null; attemptedKey = null; fallbackKey = null; reconcile()
    }
  })
  button.onclick = async () => {
    if (busy || !invoke) return
    if (active()) {
      pausedRoom = desiredRoom?.id; busy = true; mutationEpoch++
      try { await stopRelay() }
      catch (error) { window.EchoApp?.toast(String(error)) }
      finally { busy = false; render(); reconcile() }
    } else if (room?.joined) {
      desiredRoom = { ...room, role: room.role === 'host' ? 'host' : 'guest' }; pausedRoom = null; attemptedKey = null; fallbackKey = null; reconcile()
    }
  }
  async function maybeFallback() {
    const target = desiredRoom
    const key = target ? `${target.id}:${target.role}` : null
    if (!target || busy || pausedRoom === target.id || fallbackKey === key || transportMode?.value === 'wss') return
    if (status.roomId !== target.id || status.phase !== 'error' || status.transport !== 'quic' || status.fallbackEligible !== true || status.gameStarted) return
    fallbackKey = key; attemptedKey = null
    diagnostic(`fallback room=${target.id} from=quic to=wss reason=${status.detail}`)
    window.EchoApp?.toast('QUIC 连接不可用，正在切换到 WSS…')
    await reconcile()
  }
  if (invoke) setInterval(async () => {
    if (polling || busy) return
    polling = true
    const epoch = mutationEpoch
    try { const next = await invoke('relay_status'); if (epoch !== mutationEpoch) return; if (!(next.phase === 'idle' && status.phase === 'error')) status = next; render(); await maybeFallback() } catch (error) { detail.textContent = String(error) }
    finally { polling = false }
  }, 1000)
  render()
})()
