(() => {
  const $ = s => document.querySelector(s)
  const invoke = window.__TAURI__?.core?.invoke
  window.EchoDesktop = Boolean(invoke)
  let busy = false, last = {}, lastResults = '', scanActive = false
  function tab(game) {
    $('#audio-settings-body').hidden = game; $('#game-settings-body').hidden = !game
    $('#settings-game-tab').classList.toggle('selected', game); $('#settings-audio-tab').classList.toggle('selected', !game)
    $('.settings-topbar > span').textContent = game ? '游戏与启动' : '语音和视频'
    $('.audio-settings-dialog').setAttribute('aria-labelledby', game ? 'settings-game-tab' : 'audio-settings-title')
    if (game) window.EchoAudio?.stopTests?.()
  }
  $('#settings-game-tab').onclick = () => tab(true)
  $('#settings-audio-tab').onclick = () => tab(false)
  document.querySelectorAll('[data-open-audio-settings]').forEach(b => b.addEventListener('click', () => tab(false)))
  $('#game-configure').hidden = false; $('#game-configure').textContent = '游戏设置'
  $('#game-configure').onclick = () => { $('#audio-settings').hidden = false; tab(true); $('#settings-game-tab').focus() }
  const feedback = message => { $('#game-setting-feedback').textContent = message }
  function render(state) {
    last = state
    const version = state.version || '未知'
    $('#game-install-path').value = state.path || ''
    $('#game-install-version').textContent = `文件版本：${version}${state.version ? '（读取 Game.dll，缺失时读取 war3.exe）' : ' · 请在游戏内确认版本'}`
    $('#game-install-badge').textContent = state.running ? '运行中' : state.valid ? '已配置' : state.path ? '路径失效' : '未配置'
    $('#game-launch-title').textContent = state.running ? '魔兽进程运行中' : state.valid ? '本机客户端已就绪' : '请先配置本机游戏'
    $('#game-launch-status').textContent = state.valid ? `文件版本 ${version} · 请确认与好友使用同一版本。` : '在用户设置中配置一次，即可在所有房间使用。'
    $('#game-launch').disabled = busy || state.running || !state.valid
    $('#game-launch span').textContent = state.running ? '运行中' : '启动魔兽'
    $('#game-browse').disabled = busy || state.running
    $('#game-search').disabled = busy || scanActive || state.running
  }
  async function action(command, args) {
    if (busy) return
    busy = true; render(last); feedback('处理中…')
    try { const result = await invoke(command, args); busy = false; render(result); feedback(command === 'launch_game' ? '已发送启动请求。' : '当前配置已保存。') }
    catch (error) { busy = false; render(last); feedback(String(error)); window.EchoApp?.toast(String(error)) }
  }
  if (!invoke) {
    $('#game-browse').disabled = true; $('#game-search').disabled = true
    feedback('请在 Windows 客户端中配置游戏。浏览器无法搜索本机安装目录或启动游戏。')
    return
  }
  $('#game-browse').onclick = () => action('choose_game')
  $('#game-launch').onclick = () => action('launch_game')
  async function pollScan() {
    const scan = await invoke('scan_status'); scanActive = scan.running; render(last)
    if (!scan.root) return
    $('#game-search-panel').hidden = false; $('#game-search-cancel').hidden = !scan.running
    $('#game-search-progress').textContent = `${scan.running ? '搜索中' : scan.cancelled ? '已停止' : scan.limited ? '达到搜索上限，请缩小目录范围' : '搜索完成'} · ${scan.visited} 个目录 · 找到 ${scan.results.length} 个客户端 · 跳过 ${scan.skipped} 项。${scan.root}`
    const key = JSON.stringify(scan.results)
    if (key === lastResults) return
    lastResults = key; $('#game-search-results').replaceChildren()
    scan.results.forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'game-search-result'
      const copy = document.createElement('div'), title = document.createElement('strong'), path = document.createElement('p'), button = document.createElement('button')
      title.textContent = `魔兽争霸 III · ${item.version || '版本未知'}`; path.textContent = item.path
      button.className = 'room-button'; button.textContent = '使用此客户端'; button.onclick = () => action('select_search_result', { index })
      copy.append(title, path); row.append(copy, button); $('#game-search-results').append(row)
    })
  }
  $('#game-search').onclick = async () => {
    if (busy || scanActive) return
    scanActive = true; lastResults = ''; $('#game-search-results').replaceChildren(); render(last); feedback('请选择要搜索的目录，例如 D:\\Games。')
    try { await invoke('search_game'); await pollScan(); feedback('搜索不会修改游戏文件。') }
    catch (error) { scanActive = false; render(last); feedback(String(error)) }
  }
  $('#game-search-cancel').onclick = () => invoke('cancel_scan').catch(e => feedback(String(e)))
  invoke('game_status').then(render).catch(e => feedback(String(e)))
  setInterval(async () => {
    if (document.hidden || busy) return
    try { render(await invoke('game_status')); if (scanActive || !$('#game-settings-body').hidden) await pollScan() } catch (error) { feedback(String(error)) }
  }, 1500)
})()
