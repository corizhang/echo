(() => {
  const invoke = window.__TAURI__?.core?.invoke
  const button = document.querySelector('#relay-toggle'), detail = document.querySelector('#relay-detail'), metrics = document.querySelector('#relay-metrics')
  let room, status = { phase: 'idle' }, busy = false, polling = false
  const active = () => !['idle','error'].includes(status.phase)
  const diagnostic = (message) => invoke?.('write_client_log', { message: `relay-ui ${message}` }).catch(() => {})
  function render() {
    button.disabled = !invoke || busy || (!active() && !room?.joined)
    button.textContent = active() ? '断开联机' : '开启联机'
    if (!invoke) return
    detail.textContent = active() || status.phase === 'error' ? status.detail : room?.joined ? '中转尚未连接。双方开启后，由 Echo 房主在游戏内建图。' : '加入房间后才能开启联机。'
    if (active() && room?.id !== status.roomId) detail.textContent = `另一个房间的联机仍在运行。${status.detail}`
    if (!active()) { metrics.textContent = ''; return }
    const peerNetwork = status.peerNetwork || []
    const latency = peerNetwork.map(peer => {
      const role = peer.role === 'host' ? '房主' : '加入者'
      const rtt = peer.rttMs == null ? '测量中' : `${peer.rttMs} ms`
      const jitter = peer.jitterMs == null ? '—' : `${peer.jitterMs} ms`
      return `${role}到中转 ${rtt}（抖动 ${jitter}，心跳超时 ${peer.missedPongs}）`
    }).join(' · ')
    const rtts = peerNetwork.filter(peer => Number.isFinite(peer.rttMs)).map(peer => peer.rttMs)
    const estimate = rtts.length === 2 ? ` · 玩家间网络往返估算约 ${rtts.reduce((sum, value) => sum + value, 0)} ms` : ''
    metrics.textContent = `${latency || '正在测量到中转延迟'}${estimate} · 中转端点 ${status.peers}/2 · 对局广播 ${status.advertisements} 次 · 发送 ${(status.sentBytes/1024).toFixed(1)} KB / 接收 ${(status.receivedBytes/1024).toFixed(1)} KB`
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
        await invoke('start_relay', { roomId: target, ticket: ticket.ticket })
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
