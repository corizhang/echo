(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg'

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg'); svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(SVG_NS, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use)
    return svg
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  function create({ durationMs = 0, loadAudio, transcript = '' }) {
    const card = document.createElement('div'); card.className = 'message-voice-card qq-voice-card'
    const play = document.createElement('button'); play.type = 'button'; play.className = 'qq-voice-play'; play.setAttribute('aria-label', '播放语音'); play.title = '播放语音'; play.append(icon('play'))
    const wave = document.createElement('div'); wave.className = 'qq-voice-wave'; wave.setAttribute('role', 'img'); wave.setAttribute('aria-label', '语音进度')
    const bars = Array.from({ length: 27 }, (_, index) => {
      const bar = document.createElement('i'); bar.style.setProperty('--bar-height', `${4 + ((index * 17 + index * index * 3) % 12)}px`); wave.append(bar); return bar
    })
    const time = document.createElement('time'); time.className = 'qq-voice-duration'; time.textContent = formatDuration(durationMs)
    const audio = document.createElement('audio'); audio.className = 'voice-message-source'; audio.preload = 'none'; audio.setAttribute('aria-hidden', 'true')
    const error = document.createElement('small'); error.className = 'voice-message-error'; error.setAttribute('role', 'status')
    card.append(play, wave, time, audio, error)
    if (transcript) {
      const text = document.createElement('p'); text.className = 'voice-message-transcript'; text.textContent = transcript
      card.append(text)
    }

    let loading = null
    let knownDuration = Number(durationMs) || 0
    const setPlaying = (playing) => {
      play.replaceChildren(icon(playing ? 'pause' : 'play'))
      play.setAttribute('aria-label', playing ? '暂停语音' : '播放语音')
      play.title = playing ? '暂停语音' : '播放语音'
      card.classList.toggle('is-playing', playing)
    }
    const refresh = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration / 1000
      if (duration > 0) {
        knownDuration = duration * 1000
        time.textContent = formatDuration(knownDuration)
        const progress = audio.currentTime / duration
        bars.forEach((bar, index) => bar.classList.toggle('is-played', index / bars.length < progress))
      }
      setPlaying(!audio.paused && !audio.ended)
    }
    audio.addEventListener('loadedmetadata', refresh)
    audio.addEventListener('durationchange', refresh)
    audio.addEventListener('timeupdate', refresh)
    audio.addEventListener('play', refresh)
    audio.addEventListener('pause', refresh)
    audio.addEventListener('ended', () => { audio.currentTime = 0; refresh() })
    play.addEventListener('click', async () => {
      error.textContent = ''
      if (!audio.src) {
        if (!loading) {
          play.disabled = true; card.classList.add('is-loading')
          loading = Promise.resolve().then(loadAudio).then((url) => { audio.src = url; audio.load() }).catch(() => { error.textContent = '语音加载失败或你没有访问权限'; throw new Error('voice_load_failed') }).finally(() => { loading = null; play.disabled = false; card.classList.remove('is-loading') })
        }
        try { await loading } catch { return }
      }
      if (audio.paused) {
        document.querySelectorAll('.voice-message-source').forEach((other) => { if (other !== audio && !other.paused) other.pause() })
        try { await audio.play() } catch { error.textContent = '无法播放这条语音' }
      } else audio.pause()
    })
    return card
  }

  window.EchoVoicePlayer = { create }
})()
