// Spoken replies. Answers are spoken sentence by sentence as `speech.say-chunk` arrives, so
// speech starts before the reply is finished. Default engine: Windows voices, rendered to WAV
// by the native agent and played by the voice renderer's WebAudio player (echo cancelled, so
// barge-in works). speechSynthesis is the fallback when the agent is not running. OpenAI
// voices are optional.
//
// Before a turn speaks, the default output device is checked: muted → nothing is spoken, the
// answer card offers Unmute (and the answer is copied when the user asked for that). While a
// screen reader runs, Lumen stays quiet and answers go to the screen reader instead.
import type { TtsMessage } from '@shared/channels'
import { bus } from '../../bus'
import { getAgent } from '../../agent/instance'
import { loadConfig } from '../../config'
import { log } from '../../logger'
import { screenReaderActive } from '../../a11y/at-state'
import * as assistant from '../../windows/assistant'
import { voiceLatency } from '../latency'
import { forTheEar } from './ear'
import { openAiTtsAvailable, synthOpenAi } from './openai'
import { OutputGate, ttsAllowed } from './output'
import { TurnSpeech, ttsEngine, type TtsEngine } from './turns'
import { WinVoices } from './win-voices'

const OUTPUT_CHECK_MS = 600

const turns = new TurnSpeech()
const helper = new WinVoices(getAgent)
// Bumped on stop; audio from an older generation is dropped and its synthesis cancelled.
let generation = 0
let aborter = new AbortController()
let seq = 0
let chain: Promise<void> = Promise.resolve()
/** The latest finished answer, for copy-when-muted and speaking it again after Unmute. */
let lastAnswer: { turnId: string; spoken: string; shown: string } | null = null
let mutedTurn: string | null = null
let announceAnswer: (text: string) => void = () => {}

const output = new OutputGate(
  () => helper.outputState(OUTPUT_CHECK_MS),
  (turnId) => onMuted(turnId)
)

function send(msg: TtsMessage): void {
  assistant.send('voice:tts', msg)
}

/** Routes answers to the screen reader (a11y announce); set by main at startup. */
export function setAnswerAnnouncer(fn: (text: string) => void): void {
  announceAnswer = fn
}

export function stopSpeaking(): void {
  generation++
  aborter.abort()
  aborter = new AbortController()
  chain = Promise.resolve()
  send({ op: 'stop' })
}

function onMuted(turnId: string): void {
  log('step', 'tts skipped: sound output is muted')
  mutedTurn = turnId
  assistant.setNotice({ text: 'Sound is muted', action: 'unmute' })
  if (lastAnswer?.turnId === turnId) copyIfWanted(lastAnswer.shown)
}

function copyIfWanted(text: string): void {
  if (!loadConfig().voice.copyWhenMuted) return
  assistant.copyText(text)
  log('step', 'answer copied (sound muted)')
}

/** Unmute button: clear the mute, then speak the answer that was skipped. */
export async function unmuteAndSpeak(): Promise<void> {
  assistant.setNotice(undefined)
  try {
    await helper.unmute()
  } catch (e) {
    log('fail', `unmute failed: ${(e as Error).message}`)
    return
  }
  const skipped = mutedTurn
  mutedTurn = null
  if (skipped) output.forget(skipped)
  if (lastAnswer && lastAnswer.turnId === skipped) {
    stopSpeaking()
    say(lastAnswer.spoken, skipped)
  }
}

function synth(
  engine: 'windows' | 'cloud',
  text: string,
  voice: string,
  rate: number,
  signal: AbortSignal,
  lang: string
): Promise<{ mime: string; data: string }> {
  return engine === 'cloud'
    ? synthOpenAi(text, voice, rate).then((data) => ({ mime: 'audio/mpeg', data }))
    : helper.synth(text, voice, rate, signal, lang).then((data) => ({ mime: 'audio/wav', data }))
}

/**
 * Queues `text` for the voice renderer; false when nothing will be played. `orEngine`: the
 * engine used when spoken replies are off (a one-off the user asked for).
 */
function say(text: string, turnId: string, orEngine?: TtsEngine): boolean {
  const cfg = loadConfig()
  const engine = ttsEngine(cfg.voice.tts, openAiTtsAvailable()) ?? orEngine
  const clean = forTheEar(text)
  if (!engine || !clean) return false
  const n = seq++
  const { ttsVoice: voice, ttsRate: rate, language: lang } = cfg.voice
  const fallback: TtsMessage = { op: 'say', turnId, seq: n, text: clean, voice, rate, lang }
  const checkOutput = helper.canCheckOutput
  if (engine === 'windows' && !helper.usable) {
    send(fallback)
    voiceLatency.mark('tts-first-audio', turnId)
    return true
  }
  // Synthesis starts now; playback order is kept by chaining the sends.
  const gen = generation
  const audio = synth(engine, clean, voice, rate, aborter.signal, lang)
  audio.catch(() => {})
  chain = chain.then(async () => {
    if (checkOutput && (await output.mutedFor(turnId))) return
    try {
      const data = await audio
      if (gen === generation) {
        send({ op: 'audio', turnId, seq: n, ...data })
        voiceLatency.mark('tts-first-audio', turnId)
      }
    } catch (e) {
      log('fail', `tts ${engine} failed, using speechSynthesis: ${(e as Error).message}`)
      if (gen === generation) send(fallback)
    }
  })
  return true
}

/** Lumen's voice is on and no screen reader is speaking for the user. */
function turnSpeaks(): boolean {
  const cfg = loadConfig()
  if (cfg.voice.tts === 'off') return false
  return ttsAllowed(screenReaderActive(), cfg.voice.ttsWithScreenReader)
}

/** Speaks `text` now (settings preview, announce fallback). During a turn it does nothing. */
export async function speakAnswer(text: string): Promise<void> {
  speakNow(text)
}

/**
 * speakAnswer, returning the turn id its playback reports with (`speech.finished`), or null
 * when nothing is played (a turn is running, empty text). Throws when spoken replies are off.
 */
export function speakNow(text: string): string | null {
  if (turns.current) return null
  if (!ttsEngine(loadConfig().voice.tts, openAiTtsAvailable())) {
    throw new Error('Spoken replies are off')
  }
  stopSpeaking()
  const id = `preview-${seq}`
  return say(text, id) ? id : null
}

/**
 * Speaks `text` once even when spoken replies are off ("repeat that"): the Windows voice then.
 * Returns the id its playback reports with, or null when nothing is played (a turn runs).
 */
export function speakOnce(text: string): string | null {
  if (turns.current) return null
  stopSpeaking()
  const id = `preview-${seq}`
  return say(text, id, 'windows') ? id : null
}

/**
 * A short message (error, confirm prompt) spoken now, also while a turn runs: then it is
 * queued after the turn's own speech instead of being dropped. Null when spoken replies are
 * off or nothing is played.
 */
export function speakAlert(text: string): string | null {
  if (!ttsEngine(loadConfig().voice.tts, openAiTtsAvailable())) return null
  const turn = turns.current
  if (turn) return say(text, turn) ? turn : null
  stopSpeaking()
  const id = `preview-${seq}`
  return say(text, id) ? id : null
}

/** Loads the Windows voice list early when spoken replies are on. */
export function warmTts(): void {
  if (loadConfig().voice.tts !== 'off') helper.warm()
}

assistant.setUnmuteHandler(() => void unmuteAndSpeak())

bus.on('query.started', ({ turnId }) => {
  stopSpeaking()
  turns.start(turnId)
  if (mutedTurn) assistant.setNotice(undefined)
  mutedTurn = null
})
bus.on('speech.say-chunk', ({ turnId, text }) => {
  turns.markSpoken(turnId)
  if (turnSpeaks() && !turns.isSilenced(turnId)) say(text, turnId)
})
bus.on('query.done', ({ turnId, response }) => {
  turns.end(turnId)
  if (response.mode !== 'answer') return
  const text = (response.spoken ?? response.text ?? '').trim()
  if (!text) return
  lastAnswer = { turnId, spoken: text, shown: response.text?.trim() || text }
  if (mutedTurn === turnId) copyIfWanted(lastAnswer.shown)
  if (screenReaderActive() && !turnSpeaks()) {
    announceAnswer(text)
    return
  }
  // Replies that were not streamed (plans, fallbacks) are spoken whole once they are done.
  if (!turns.hasSpoken(turnId) && !turns.isSilenced(turnId) && turnSpeaks()) say(text, turnId)
})
bus.on('query.failed', ({ turnId }) => turns.end(turnId))
bus.on('query.cancelled', ({ turnId }) => {
  turns.end(turnId)
  stopSpeaking()
})
// The user starting to talk silences Lumen for the rest of the turn (hotkey, wake word and
// voice barge-in).
function interrupted(): void {
  turns.silenceCurrent()
  stopSpeaking()
}
bus.on('voice.started', interrupted)
bus.on('voice.cancelled', interrupted)
bus.on('dictation.started', interrupted)
