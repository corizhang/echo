(() => {
  const invoke = window.__TAURI__?.core?.invoke
  const button = document.querySelector('#relay-toggle'), detail = document.querySelector('#relay-detail'), metrics = document.querySelector('#relay-metrics')
  const diagnosticsPanel = document.querySelector('#relay-diagnostics'), chart = document.querySelector('#relay-rtt-chart')
  const diagnosticsSummary = document.querySelector('#relay-diagnostics-summary'), clientPingSummary = document.querySelector('#relay-client-ping-summary')
  const transportMode = document.querySelector('#relay-transport-mode')
  let room, status = { phase: 'idle' }, busy = false, polling = false
  if (transportMode) transportMode.value = localStorage.getItem('echo-relay-transport-mode') === 'wss' ? 'wss' : 'auto'
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
    button.disabled = !invoke || busy || (!active() && !room?.joined)
    button.textContent = active() ? '断开联机' : '开启联机'
    if (!invoke) return
    detail.textContent = active() || status.phase === 'error' ? status.detail : room?.joined ? '中转尚未连接。双方开启后，由 Echo 房主在游戏内建图。' : '加入房间后才能开启联机。'
    if (active() && room?.id !== status.roomId) detail.textContent = `另一个房间的联机仍在运行。${status.detail}`
    if (!active()) { metrics.textContent = ''; diagnosticsPanel.hidden = !invoke; return }
    const peerNetwork = status.peerNetwork || []
    const self = peerNetwork.find(peer => peer.role === status.role)
    const latency = peerNetwork.map(peer => {
      const role = peer.role === 'host' ? '房主' : '加入者'
      const rtt = peer.rttMs == null ? '测量中' : `${peer.rttMs} ms`
      const jitter = peer.jitterMs == null ? '—' : `${peer.jitterMs} ms`
      return `${role}到中转 ${rtt}（抖动 ${jitter}，心跳超时 ${peer.missedPongs}）`
    }).join(' · ')
    const rtts = peerNetwork.filter(peer => Number.isFinite(peer.rttMs)).map(peer => peer.rttMs)
    const estimate = rtts.length === 2 ? ` · 玩家间网络往返估算约 ${rtts.reduce((sum, value) => sum + value, 0)} ms` : ''
    const transport = status.transport === 'quic' ? 'QUIC/UDP' : status.transport === 'wss' ? 'WSS/TCP（回退）' : '连接中'
    metrics.textContent = `${transport} · ${latency || '正在测量到中转延迟'}${estimate} · 中转端点 ${status.peers}/2 · 对局广播 ${status.advertisements} 次 · 发送 ${(status.sentBytes/1024).toFixed(1)} KB / 接收 ${(status.receivedBytes/1024).toFixed(1)} KB`
    renderDiagnostics(self)
  }
  window.addEventListener('echo:room-context', event => { room = event.detail; render() })
  window.addEventListener('echo:room-left', event => { if (invoke && status.roomId === event.detail) invoke('stop_relay').catch(() => {}) })
  button.onclick = async () => {
    if (busy || !invoke) return
    busy = true; render()
    await diagnostic('button clicked')
    try {
      if (active()) await invoke('stop_relay')
      else {
        const target = room.id
        await diagnostic('requesting relay ticket')
        const ticket = await window.EchoApi.getGameRelayTicket(target)
        await diagnostic('relay ticket received')
        if (room?.id !== target || !room?.joined) throw new Error('房间已切换，请重新开启联机')
        await diagnostic('invoking native start_relay')
        await invoke('start_relay', { roomId: target, ticket: ticket.ticket, transportMode: transportMode?.value || 'auto' })
        await diagnostic('native start_relay returned')
      }
      status = await invoke('relay_status')
    } catch (error) {
      await diagnostic(`operation failed: ${String(error.message || error)}`)
      window.EchoApp?.toast(String(error.message || error)); detail.textContent = String(error.message || error)
    }
    finally { busy = false; button.disabled = !invoke || (!active() && !room?.joined); button.textContent = active() ? '断开联机' : '开启联机' }
  }
  if (invoke) setInterval(async () => {
    if (polling || busy) return
    polling = true
    try { status = await invoke('relay_status'); render() } catch (error) { detail.textContent = String(error) }
    finally { polling = false }
  }, 1000)
  render()
})()
