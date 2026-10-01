// Plays spoken replies in the voice renderer (the one that owns the microphone, so echo
// cancellation can hear it). Windows voices go through speechSynthesis, which exposes the
// installed OneCore voices in Electron; cloud audio plays as a gapless-enough element queue.
import type { TtsMessage } from '@shared/channels'

/** Installed voices, waiting briefly for Chromium to load the list. */
export function windowsVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (): void => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      resolve(speechSynthesis.getVoices())
    }
    speechSynthesis.addEventListener('voiceschanged', done)
    setTimeout(done, 1500)
  })
}

/** The chosen voice by name, else the first local English one, else the system default. */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  name: string
): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => v.name === name) ??
    voices.find((v) => v.localService && v.lang.toLowerCase().startsWith('en')) ??
    voices.find((v) => v.default) ??
    null
  )
}

let audioQueue: HTMLAudioElement[] = []
let playing: HTMLAudioElement | null = null

function playNext(): void {
  if (playing) return
  const next = audioQueue.shift()
  if (!next) return
  playing = next
  const done = (): void => {
    if (playing !== next) return
    playing = null
    playNext()
  }
  next.onended = done
  next.onerror = done
  next.play().catch(done)
}

function stopAll(): void {
  speechSynthesis.cancel()
  audioQueue = []
  if (playing) {
    playing.onended = null
    playing.onerror = null
    playing.pause()
    playing = null
  }
}

async function sayWindows(msg: Extract<TtsMessage, { op: 'say' }>): Promise<void> {
  const u = new SpeechSynthesisUtterance(msg.text)
  const voice = pickVoice(await windowsVoices(), msg.voice)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  u.rate = Math.max(0.5, Math.min(2, msg.rate))
  speechSynthesis.speak(u)
}

/** Starts listening for main's playback messages; returns the unsubscribe function. */
export function startSpeaker(): () => void {
  const off = window.lumen.on('voice:tts', (msg) => {
    if (msg.op === 'stop') stopAll()
    else if (msg.op === 'say') sayWindows(msg).catch(() => {})
    else {
      audioQueue.push(new Audio(`data:${msg.mime};base64,${msg.data}`))
      playNext()
    }
  })
  return () => {
    off()
    stopAll()
  }
}
