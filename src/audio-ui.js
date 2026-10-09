(() => {
  const $ = (selector) => document.querySelector(selector)
  const STORAGE_KEY = 'echo.audio.v1'
  const readPreferences = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
  const preferences = readPreferences()
  let testStream, testContext, meterFrame, testAudio, testToneContext, stopToneTimer
  const dialog = $('#audio-settings')
  const inputSelect = $('#audio-input-device')
  const outputSelect = $('#audio-output-device')
  const status = (selector, text, error = false) => { const node = $(selector); node.textContent = text; node.classList.toggle('is-error', error) }
  const toast = (text) => { const node = document.createElement('div'); node.className = 'toast'; node.textContent = text; $('#toast-region').append(node); setTimeout(() => node.remove(), 3200) }
  function savePreferences() { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)) }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('此浏览器不支持媒体设备枚举')
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter((item) => item.kind === 'audioinput')
    const outputs = devices.filter((item) => item.kind === 'audiooutput')
    fillOptions(inputSelect, inputs, 'audioinput', preferences.inputDeviceId)
    fillOptions(outputSelect, outputs, 'audiooutput', preferences.outputDeviceId)
    renderDeviceMenu('input', inputs, preferences.inputDeviceId)
    renderDeviceMenu('output', outputs, preferences.outputDeviceId)
    $('#speaker-test-button').disabled = typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined'
    if (!outputs.length) status('#speaker-test-status', '浏览器暂未提供输出设备；默认扬声器仍可用于播放。')
  }

  function renderDeviceMenu(kind, devices, selectedId) {
    const list = $(`#${kind}-device-options`)
    if (!list) return
    const label = kind === 'input' ? '麦克风' : '扬声器 / 耳机'
    const entries = [{ deviceId: 'default', label: `Windows 默认`, detail: '系统默认设备' }, ...devices.filter((device) => device.deviceId && device.deviceId !== 'default').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `${label} ${index + 1}`, detail: device.groupId ? '已连接的音频设备' : '' }))]
    list.replaceChildren()
    for (const device of entries) {
      const item = document.createElement('button')
      item.type = 'button'; item.className = 'device-option'; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(device.deviceId === selectedId))
      const iconName = kind === 'input' ? 'i-mic' : 'i-headphones'
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.classList.add('icon'); icon.innerHTML = `<use href="#${iconName}"></use>`
      const copy = document.createElement('span'); copy.className = 'device-option-copy'
      const name = document.createElement('strong'); name.textContent = device.label
      const detail = document.createElement('small'); detail.textContent = device.detail
      copy.append(name, detail)
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); check.classList.add('icon', 'device-option-check'); check.innerHTML = '<use href="#i-check"></use>'
      item.append(icon, copy, check)
      item.addEventListener('click', () => {
        const select = kind === 'input' ? inputSelect : outputSelect
        select.value = device.deviceId
        select.dispatchEvent(new Event('change', { bubbles: true }))
        closeDeviceMenus()
      })
      list.append(item)
    }
  }

  function closeDeviceMenus() {
    for (const [id, buttonId] of [['input-device-popover', 'input-device-menu-button'], ['output-device-popover', 'output-device-menu-button']]) {
      $(`#${id}`).hidden = true
      $(`#${buttonId}`).setAttribute('aria-expanded', 'false')
    }
  }

  function toggleDeviceMenu(kind) {
    const id = `${kind}-device-popover`
    const buttonId = `${kind}-device-menu-button`
    const open = $(`#${id}`).hidden
    closeDeviceMenus()
    if (open) {
      const popover = $(`#${id}`); const button = $(`#${buttonId}`)
      popover.hidden = false
      const rect = button.getBoundingClientRect()
      const width = popover.getBoundingClientRect().width
      popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
      popover.style.bottom = `${window.innerHeight - rect.top + 8}px`
      button.setAttribute('aria-expanded', 'true')
    }
  }

  function fillOptions(select, devices, kind, selectedId) {
    const label = kind === 'audioinput' ? '麦克风' : '扬声器 / 耳机'
    select.replaceChildren()
    const defaultOption = document.createElement('option')
    defaultOption.value = 'default'; defaultOption.textContent = `系统默认${label}`; select.append(defaultOption)
    devices.filter((device) => device.deviceId && device.deviceId !== 'default').forEach((device, index) => {
      const option = document.createElement('option'); option.value = device.deviceId
      option.textContent = device.label || `${label} ${index + 1}（名称需授权后显示）`; select.append(option)
    })
    if (selectedId && [...select.options].some((option) => option.value === selectedId)) select.value = selectedId
    else { select.value = 'default'; if (kind === 'audioinput') preferences.inputDeviceId = 'default'; else preferences.outputDeviceId = 'default' }
  }

  async function startMicTest() {
    stopMicTest()
    const deviceId = inputSelect.value
    const constraints = deviceId === 'default' ? { audio: true } : { audio: { deviceId: { exact: deviceId } } }
    try {
      testStream = await navigator.mediaDevices.getUserMedia(constraints)
      const Context = window.AudioContext || window.webkitAudioContext
      testContext = new Context(); await testContext.resume()
      const analyser = testContext.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.78
      testContext.createMediaStreamSource(testStream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const meter = $('.mic-meter'); const fill = $('#mic-meter-level'); const value = $('#mic-meter-value')
      status('#mic-test-status', '正在监听麦克风；请说话或轻拍麦克风。')
      $('#mic-test-button').querySelector('span').textContent = '停止测试'
      const draw = () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0; for (const sample of samples) { const centered = (sample - 128) / 128; sum += centered * centered }
        const level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 320))
        fill.style.width = `${level}%`; value.textContent = `${level}%`; meter.setAttribute('aria-valuenow', String(level))
        meter.classList.toggle('has-signal', level > 4)
        meterFrame = requestAnimationFrame(draw)
      }
      draw()
      await refreshDevices()
      status('#mic-test-status', '麦克风工作正常。电平会随声音实时变化。')
    } catch (error) {
      stopMicTest()
      const message = error.name === 'NotAllowedError' ? '麦克风权限未允许；请在浏览器地址栏权限设置中允许此站点使用麦克风。' : error.name === 'NotFoundError' ? '没有找到可用的麦克风。' : error.message || '无法启动麦克风测试。'
      status('#mic-test-status', message, true); toast(message)
      try { await refreshDevices() } catch { /* Keep the permission error visible. */ }
    }
  }

  function stopMicTest() {
    if (meterFrame) cancelAnimationFrame(meterFrame); meterFrame = undefined
    testStream?.getTracks().forEach((track) => track.stop()); testStream = undefined
    if (testContext && testContext.state !== 'closed') testContext.close().catch(() => {}); testContext = undefined
    const fill = $('#mic-meter-level'); const value = $('#mic-meter-value'); const meter = $('.mic-meter')
    if (fill) fill.style.width = '0%'; if (value) value.textContent = '未测试'; if (meter) { meter.setAttribute('aria-valuenow', '0'); meter.classList.remove('has-signal') }
    const button = $('#mic-test-button'); if (button) button.querySelector('span').textContent = '麦克风测试'
  }

  async function playSpeakerTest() {
    stopSpeakerTest()
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context) { status('#speaker-test-status', '此浏览器不支持输出测试音。', true); return }
    try {
      const deviceId = outputSelect.value
      testToneContext = new Context()
      let destination = testToneContext.destination
      if (deviceId !== 'default') {
        if (typeof testToneContext.setSinkId === 'function') await testToneContext.setSinkId(deviceId)
        else if (typeof HTMLMediaElement.prototype.setSinkId === 'function') {
          const mediaDestination = testToneContext.createMediaStreamDestination()
          testAudio = new Audio(); testAudio.srcObject = mediaDestination.stream; await testAudio.setSinkId(deviceId); await testAudio.play(); destination = mediaDestination
        } else throw new Error('浏览器不支持选择输出设备；请使用系统默认扬声器。')
      }
      await testToneContext.resume()
      const oscillator = testToneContext.createOscillator(); const gain = testToneContext.createGain()
      oscillator.type = 'sine'; oscillator.frequency.value = 440
      const now = testToneContext.currentTime
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.14, now + 0.04); gain.gain.setValueAtTime(0.14, now + 0.4); gain.gain.linearRampToValueAtTime(0, now + 0.65)
      oscillator.connect(gain); gain.connect(destination); oscillator.start(now); oscillator.stop(now + 0.68)
      status('#speaker-test-status', '已播放 440 Hz 测试音；是否听到声音？')
      $('#speaker-test-button').querySelector('span').textContent = '正在播放…'
      stopToneTimer = setTimeout(stopSpeakerTest, 850)
    } catch (error) { status('#speaker-test-status', error.message || '播放测试音失败。', true); stopSpeakerTest() }
  }

  function stopSpeakerTest() {
    clearTimeout(stopToneTimer); stopToneTimer = undefined
    if (testAudio) { testAudio.pause(); testAudio.srcObject?.getTracks().forEach((track) => track.stop()); testAudio.srcObject = null; testAudio = undefined }
    if (testToneContext && testToneContext.state !== 'closed') testToneContext.close().catch(() => {}); testToneContext = undefined
    const button = $('#speaker-test-button'); if (button) button.querySelector('span').textContent = '播放测试音'
  }

  $('#open-audio-settings').addEventListener('click', async () => {
    closeDeviceMenus()
    dialog.hidden = false
    try { await refreshDevices() } catch (error) { status('#mic-test-status', error.message || '无法读取音频设备。', true) }
  })
  $('#close-audio-settings').addEventListener('click', closeSettings)
  document.querySelectorAll('[data-open-audio-settings]').forEach((button) => button.addEventListener('click', async () => { closeDeviceMenus(); dialog.hidden = false; try { await refreshDevices() } catch (error) { status('#mic-test-status', error.message || '无法读取音频设备。', true) } }))
  $('#input-device-menu-button').addEventListener('click', () => toggleDeviceMenu('input'))
  $('#output-device-menu-button').addEventListener('click', () => toggleDeviceMenu('output'))
  document.addEventListener('click', (event) => { if (!event.target.closest('.profile-bar') && !event.target.closest('.device-popover')) closeDeviceMenus() })
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeSettings() })
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.hidden) closeSettings() })
  $('#refresh-audio-devices').addEventListener('click', async () => { try { await refreshDevices(); toast('音频设备列表已刷新') } catch (error) { toast(error.message || '刷新设备失败') } })
  $('#mic-test-button').addEventListener('click', () => testStream ? stopMicTest() : startMicTest())
  $('#speaker-test-button').addEventListener('click', playSpeakerTest)
  const speakerVolume = $('#speaker-volume')
  speakerVolume.value = String(preferences.speakerVolume ?? 100)
  $('#speaker-volume-value').value = `${speakerVolume.value}%`
  speakerVolume.addEventListener('input', () => {
    preferences.speakerVolume = Number(speakerVolume.value); savePreferences()
    $('#speaker-volume-value').value = `${speakerVolume.value}%`
    window.EchoVoice?.setOutputVolume?.(preferences.speakerVolume / 100)
  })
  inputSelect.addEventListener('change', async () => {
    preferences.inputDeviceId = inputSelect.value; savePreferences()
    try { if (window.EchoVoice?.isConnected()) await window.EchoVoice.selectInput(preferences.inputDeviceId); if (testStream) await startMicTest(); status('#mic-test-status', '输入设备已更新。') }
    catch (error) { status('#mic-test-status', error.message || '无法切换输入设备。', true) }
  })
  outputSelect.addEventListener('change', async () => {
    preferences.outputDeviceId = outputSelect.value; savePreferences()
    try { if (window.EchoVoice?.isConnected()) await window.EchoVoice.selectOutput(preferences.outputDeviceId); status('#speaker-test-status', '输出设备已更新。') }
    catch (error) { status('#speaker-test-status', error.message || '无法切换输出设备。', true) }
  })
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices().catch(() => {}))

  function closeSettings() { dialog.hidden = true; stopMicTest(); stopSpeakerTest() }
  window.EchoAudio = { getInputDeviceId: () => preferences.inputDeviceId || 'default', getOutputDeviceId: () => preferences.outputDeviceId || 'default', refreshDevices }
  refreshDevices().catch(() => {})
})()
