// Voice barge-in (04 T19): talking over a spoken answer stops it and starts a new request.
//
// Armed only while the WebAudio player speaks (speechSynthesis plays outside Chromium's audio
// path, so the echo canceller cannot remove it), `voice.bargeIn` is on and the mic reports
// echo cancellation. The mic opens when speech starts (hold/tap modes included) and 20 ms
// blocks feed a level gate; 250 ms of sustained speech stops playback and tells main, which
// starts a hands-free recording. The audio from just before the trigger is kept as pre-roll
// so the first word is not lost.
//
// The wake-word feed is held quiet while Lumen speaks unless barge-in is armed (with AEC the
// spotter hears the user, not Lumen).
import tapUrl from './worklets/pcm-tap.ts?worker&url'
import { dropMic, getMicStream, holdMic, onMicChanged } from './mic'
import { BargeDetector, PcmRing, blockRms, joinPcm } from './vad/barge'
import { onSpeakingChange, speakingState, stopSpeaking, type SpeakingState } from './speaker'
import { setWakeFeedQuiet } from './wake-feed'

const HOLDER = 'barge'
const SAMPLE_RATE = 16000
const BLOCK_MS = 20
/** Pre-roll kept for the new recording: the sustain window plus 300 ms before it. */
const PRE_ROLL_MS = 600
/** A pre-roll older than this is not attached (the recording never came). */
const PRE_ROLL_TTL_MS = 3000

let enabled = false
let threshold = 0.04
let speaking: SpeakingState = null
/** The tap is wanted (or running); `armed` once it listens with echo cancellation. */
let active = false
let armed = false
let ctx: AudioContext | null = null
let generation = 0
let preRoll: { samples: Float32Array; at: number } | null = null
/** After a trigger, blocks keep being collected until the recording takes the pre-roll. */
let after: Int16Array[] | null = null
let afterTimer: ReturnType<typeof setTimeout> | null = null

function updateWake(): void {
  setWakeFeedQuiet(speaking !== null && !armed)
}

function endTail(): void {
  if (afterTimer) clearTimeout(afterTimer)
  afterTimer = null
  after = null
}

function disarm(): void {
  generation++
  active = false
  armed = false
  endTail()
  if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  ctx = null
  dropMic(HOLDER)
  updateWake()
}

function trigger(ring: PcmRing): void {
  console.log('[barge-in] speech over the answer')
  preRoll = { samples: ring.take(), at: Date.now() }
  // Set before stopping playback: the "quiet" callback must not tear the tap down.
  after = []
  // Nobody took it (barge-in turned off in main, recording failed): let the tap go.
  afterTimer = setTimeout(() => {
    endTail()
    sync()
  }, PRE_ROLL_TTL_MS)
  stopSpeaking()
  window.lumen.send('voice:barge-in')
}

async function arm(): Promise<void> {
  const gen = ++generation
  holdMic(HOLDER)
  try {
    const stream = await getMicStream()
    if (gen !== generation) return
    const track = stream.getAudioTracks()[0]
    if (track?.getSettings().echoCancellation !== true) {
      console.warn('[barge-in] off: the microphone has no echo cancellation (use headphones)')
      return
    }
    const audio = new AudioContext({ sampleRate: SAMPLE_RATE })
    ctx = audio
    await audio.audioWorklet.addModule(tapUrl)
    if (gen !== generation) return
    const node = new AudioWorkletNode(audio, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { blockMs: BLOCK_MS }
    })
    const ring = new PcmRing(Math.round((SAMPLE_RATE * PRE_ROLL_MS) / 1000))
    const detector = new BargeDetector(threshold)
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
      if (gen !== generation) return
      const block = new Int16Array(e.data)
      if (after) {
        after.push(block)
        return
      }
      ring.push(block)
      if (speakingState() === 'player' && detector.feed(blockRms(block), BLOCK_MS)) trigger(ring)
    }
    audio.createMediaStreamSource(stream).connect(node)
    await audio.resume()
    if (gen !== generation) return
    armed = true
    updateWake()
  } catch (err) {
    console.warn('[barge-in] could not listen:', err)
  }
}

function sync(): void {
  const want = enabled && speaking === 'player'
  if (want && !active) {
    active = true
    void arm()
  } else if (!want && active && !after) {
    // After a trigger the tap stays until the recording takes its pre-roll.
    disarm()
  }
  updateWake()
}

/**
 * The audio from just before the last barge-in up to now, for the recording it started.
 * Null when there was none or it is stale. Lets the barge-in tap go.
 */
export function takePreRoll(): Float32Array | null {
  const p = preRoll
  const blocks = after
  preRoll = null
  if (blocks) {
    endTail()
    sync()
  }
  if (!p || Date.now() - p.at > PRE_ROLL_TTL_MS) return null
  return joinPcm(p.samples, blocks ?? [])
}

/** Follows config (voice.bargeIn, vad.speechThreshold) and playback; returns the cleanup. */
export function startBargeIn(): () => void {
  const apply = (cfg: unknown): void => {
    const c = cfg as { voice?: { bargeIn?: unknown }; vad?: { speechThreshold?: unknown } } | null
    enabled = c?.voice?.bargeIn === true
    if (typeof c?.vad?.speechThreshold === 'number') threshold = c.vad.speechThreshold
    sync()
  }
  window.lumen
    .invoke('settings:get')
    .then(apply)
    .catch(() => {})
  const offCfg = window.lumen.on('settings:changed', apply)
  const offSpeak = onSpeakingChange((s) => {
    speaking = s
    sync()
  })
  // The shared stream was closed for another device: the tap is dead, open it again.
  const offMic = onMicChanged(() => {
    if (!active) return
    disarm()
    sync()
  })
  return () => {
    offCfg()
    offSpeak()
    offMic()
    enabled = false
    speaking = null
    disarm()
  }
}
