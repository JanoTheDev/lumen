// Streams the shared mic to main as 16 kHz Int16 PCM while main's wake-word spotter listens.
// Same stream as recording (one mic open, echo cancellation applies to both).
import tapUrl from './worklets/pcm-tap.ts?worker&url'
import { dropMic, getMicStream, holdMic, onMicChanged } from './mic'

const HOLDER = 'wake'
const REOPEN_MS = 1500

let wanted = false
let paused = false
let quiet = false
let ctx: AudioContext | null = null
let generation = 0
let reopenTimer: ReturnType<typeof setTimeout> | null = null

function teardown(): void {
  generation++
  if (reopenTimer) clearTimeout(reopenTimer)
  reopenTimer = null
  if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  ctx = null
}

function scheduleReopen(): void {
  if (!wanted || reopenTimer) return
  reopenTimer = setTimeout(() => {
    reopenTimer = null
    if (wanted) void open()
  }, REOPEN_MS)
}

async function open(): Promise<void> {
  teardown()
  const gen = generation
  holdMic(HOLDER)
  try {
    const stream = await getMicStream()
    if (gen !== generation || !wanted) return
    const audio = new AudioContext({ sampleRate: 16000 })
    ctx = audio
    await audio.audioWorklet.addModule(tapUrl)
    if (gen !== generation) return
    const node = new AudioWorkletNode(audio, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
      if (!paused && !quiet && gen === generation) window.lumen.send('voice:wake-pcm', e.data)
    }
    audio.createMediaStreamSource(stream).connect(node)
    await audio.resume()
    // The device went away (unplugged, privacy toggle): reopen on whatever is default now.
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        if (gen !== generation) return
        teardown()
        scheduleReopen()
      })
    )
    console.log('[wake] mic feed on')
  } catch (err) {
    console.warn('[wake] mic feed failed:', err)
    if (gen === generation) {
      teardown()
      scheduleReopen()
    }
  }
}

function setListening(on: boolean): void {
  if (on === wanted) return
  wanted = on
  if (on) {
    void open()
  } else {
    teardown()
    dropMic(HOLDER)
    console.log('[wake] mic feed off')
  }
}

/** While a recording runs the feed stays open but sends nothing (wake can't re-trigger). */
export function setWakeFeedPaused(on: boolean): void {
  paused = on
}

/**
 * Held quiet while Lumen speaks without echo-cancelled barge-in, so the spotter never hears
 * Lumen's own voice (it could say the wake phrase or "stop").
 */
export function setWakeFeedQuiet(on: boolean): void {
  quiet = on
}

/** Follows main's wake state; returns the cleanup. */
export function startWakeFeed(): () => void {
  const off = window.lumen.on('voice:wake-listen', setListening)
  // Another microphone was picked: move the feed to it.
  const offMic = onMicChanged(() => {
    if (wanted) void open()
  })
  window.lumen
    .invoke('voice:wake-state')
    .then((s) => setListening(s.listen))
    .catch(() => {})
  return () => {
    off()
    offMic()
    setListening(false)
  }
}
