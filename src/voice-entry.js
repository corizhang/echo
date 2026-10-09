import { Room, RoomEvent, createLocalAudioTrack } from 'livekit-client'

const $ = (selector) => document.querySelector(selector)
let room
let audioTrack
let deafened = false
let outputVolume = (() => { try { const saved = JSON.parse(localStorage.getItem('echo.audio.v1') || '{}').speakerVolume; return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved / 100)) : 1 } catch { return 1 } })()
const attachedAudio = new Map()

function selectedOutput() {
  try { return JSON.parse(localStorage.getItem('echo.audio.v1') || '{}').outputDeviceId || 'default' } catch { return 'default' }
}

async function attachRemoteAudio(track) {
  const element = track.attach()
  element.autoplay = true; element.playsInline = true; element.dataset.trackSid = track.sid
  $('#remote-audio').append(element)
  track.setVolume(deafened ? 0 : outputVolume)
  const outputId = selectedOutput()
  if (outputId !== 'default' && typeof element.setSinkId === 'function') await element.setSinkId(outputId)
  try { await element.play() } catch { room?.startAudio().catch(() => {}) }
  attachedAudio.set(track.sid, { track, element })
}

function detachRemoteAudio(track) {
  track.detach().forEach((element) => element.remove())
  attachedAudio.delete(track.sid)
}

window.EchoVoice = {
  prepareMicrophone(deviceId = 'default') {
    return createLocalAudioTrack(deviceId === 'default' ? undefined : { deviceId: { exact: deviceId } })
  },
  async connect(ticket, preparedAudioTrack) {
    // The bundled SDK's single-PC V1 join path calls RTCPeerConnection.setConfiguration
    // after creating its initial offer. Some Chromium builds reject that transition.
    // Use the SDK's compatible dual-PC/V0 path for self-hosted LiveKit.
    room = new Room({ adaptiveStream: true, dynacast: true, singlePeerConnection: false })
    const activeRoom = room
    room.on(RoomEvent.Disconnected, () => { if (room !== activeRoom) return; audioTrack = undefined; window.dispatchEvent(new Event('echo:voice-disconnected')) })
    room.on(RoomEvent.ActiveSpeakersChanged, speakers => window.dispatchEvent(new CustomEvent('echo:voice-speakers', { detail: speakers.map(speaker => speaker.identity) })))
    room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === 'audio') attachRemoteAudio(track).catch((error) => console.warn('Could not attach remote audio', error)) })
    room.on(RoomEvent.TrackUnsubscribed, (track) => { if (track.kind === 'audio') detachRemoteAudio(track) })
    try {
      // Capture before awaiting network requests so browsers can present the
      // microphone permission prompt directly in response to the user's click.
      audioTrack = preparedAudioTrack || await createLocalAudioTrack()
      await room.connect(ticket.url, ticket.token, { autoSubscribe: true })
      const outputId = selectedOutput()
      if (outputId !== 'default') {
        try { await room.switchActiveDevice('audiooutput', outputId) }
        catch (error) { console.warn('Preferred output device unavailable; using system default', error) }
      }
      await room.localParticipant.publishTrack(audioTrack)
    } catch (error) {
      audioTrack?.stop()
      await room.disconnect()
      attachedAudio.forEach(({ track }) => detachRemoteAudio(track))
      room = undefined
      audioTrack = undefined
      throw error
    }
    return room
  },
  async setMuted(muted) {
    if (!room) return
    if (muted) await room.localParticipant.setMicrophoneEnabled(false)
    else {
      if (!audioTrack) { audioTrack = await createLocalAudioTrack(); await room.localParticipant.publishTrack(audioTrack) }
      await room.localParticipant.setMicrophoneEnabled(true)
    }
  },
  isConnected() { return room?.state === 'connected' },
  async selectInput(deviceId) { if (room && deviceId) await room.switchActiveDevice('audioinput', deviceId) },
  async selectOutput(deviceId) { if (room && deviceId) await room.switchActiveDevice('audiooutput', deviceId) },
  setDeafened(value) { deafened = value; for (const { track } of attachedAudio.values()) track.setVolume(deafened ? 0 : outputVolume) },
  setOutputVolume(value) { outputVolume = Math.min(1, Math.max(0, Number(value) || 0)); for (const { track } of attachedAudio.values()) track.setVolume(deafened ? 0 : outputVolume) },
  async disconnect() { if (room) await room.disconnect(); attachedAudio.forEach(({ track }) => detachRemoteAudio(track)); room = undefined; audioTrack = undefined },
}

window.dispatchEvent(new Event('echo-voice-ready'))
