(() => {
  const invoke = window.__TAURI__?.core?.invoke
  const button = document.querySelector('#relay-toggle'), detail = document.querySelector('#relay-detail'), metrics = document.querySelector('#relay-metrics')
  let room, status = { phase: 'idle' }, busy = false, polling = false
  const active = () => !['idle','error'].includes(status.phase)
  function render() {
    button.disabled = !invoke || busy || (!active() && !room?.joined)
    button.textContent = active() ? '断开联机' : '开启联机'
    if (!invoke) return
    detail.textContent = active() || status.phase === 'error' ? status.detail : room?.joined ? '中转尚未连接。双方开启后，由 Echo 房主在游戏内建图。' : '加入房间后才能开启联机。'
    if (active() && room?.id !== status.roomId) detail.textContent = `另一个房间的联机仍在运行。${status.detail}`
    metrics.textContent = active() ? `中转端点 ${status.peers}/2 · 对局广播 ${status.advertisements} 次 · 发送 ${(status.sentBytes/1024).toFixed(1)} KB / 接收 ${(status.receivedBytes/1024).toFixed(1)} KB` : ''
  }
  window.addEventListener('echo:room-context', event => { room = event.detail; render() })
  window.addEventListener('echo:room-left', event => { if (invoke && status.roomId === event.detail) invoke('stop_relay').catch(() => {}) })
  button.onclick = async () => {
    if (busy || !invoke) return
    busy = true; render()
    try {
      if (active()) await invoke('stop_relay')
      else {
        const target = room.id
        const ticket = await window.EchoApi.getGameRelayTicket(target)
        if (room?.id !== target || !room?.joined) throw new Error('房间已切换，请重新开启联机')
        await invoke('start_relay', { roomId: target, ticket: ticket.ticket })
      }
      status = await invoke('relay_status')
    } catch (error) { window.EchoApp?.toast(String(error.message || error)); detail.textContent = String(error.message || error) }
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
