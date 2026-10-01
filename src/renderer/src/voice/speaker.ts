// Plays spoken replies in the voice renderer (the one that owns the microphone). Audio from
// main (Windows voices rendered to WAV, cloud MP3) goes through the WebAudio player, where
// echo cancellation hears it. Plain text (`say`) is the fallback through speechSynthesis.
import type { TtsMessage } from '@shared/channels'
import { TtsPlayer } from './player'

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

const player = new TtsPlayer()
let synthesizing = 0
/** Bumped by every stop; a `say` still loading voices from before it is dropped. */
let stopGeneration = 0
const listeners = new Set<(state: SpeakingState) => void>()

/**
 * What is playing: `player` = WebAudio (echo cancelled), `synthesis` = speechSynthesis (the
 * fallback; plays outside Chromium's audio path, so the mic hears it), null = quiet.
 */
export type SpeakingState = 'player' | 'synthesis' | null

export function speakingState(): SpeakingState {
  if (player.speaking) return 'player'
  return synthesizing > 0 ? 'synthesis' : null
}

/** Follows speakingState(); returns the unsubscribe function. */
export function onSpeakingChange(cb: (state: SpeakingState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let lastState: SpeakingState = null
function notify(): void {
  const now = speakingState()
  if (now === lastState) return
  lastState = now
  for (const cb of listeners) cb(now)
}
player.onSpeakingChange(notify)

/** Silences everything now (barge-in, stop, new turn). */
export function stopSpeaking(): void {
  stopGeneration++
  player.stop()
  speechSynthesis.cancel()
  synthesizing = 0
  notify()
}

async function sayWindows(msg: Extract<TtsMessage, { op: 'say' }>): Promise<void> {
  const gen = stopGeneration
  const voices = await windowsVoices()
  if (gen !== stopGeneration) return
  const u = new SpeechSynthesisUtterance(msg.text)
  const voice = pickVoice(voices, msg.voice)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  u.rate = Math.max(0.5, Math.min(2, msg.rate))
  let counted = false
  u.onstart = () => {
    counted = true
    synthesizing++
    notify()
  }
  const done = (): void => {
    if (!counted) return
    counted = false
    synthesizing = Math.max(0, synthesizing - 1)
    notify()
  }
  u.onend = done
  u.onerror = done
  speechSynthesis.speak(u)
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** Starts listening for main's playback messages; returns the unsubscribe function. */
export function startSpeaker(): () => void {
  const off = window.lumen.on('voice:tts', (msg) => {
    if (msg.op === 'stop') stopSpeaking()
    else if (msg.op === 'say') sayWindows(msg).catch(() => {})
    else void player.enqueue(base64ToBytes(msg.data))
  })
  // Main waits for quiet before a conversation listens again.
  const offState = onSpeakingChange((state) => window.lumen.send('voice:speaking', state !== null))
  return () => {
    off()
    offState()
    stopSpeaking()
  }
}
