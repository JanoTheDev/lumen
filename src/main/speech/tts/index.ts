// Spoken replies. Answers are spoken sentence by sentence as `speech.say-chunk` arrives, so
// speech starts before the reply is finished. Default engine: Windows voices, rendered to WAV
// by the voice helper and played by the voice renderer's WebAudio player (echo cancelled, so
// barge-in works). speechSynthesis is the fallback when the helper is unavailable. OpenAI
// voices are optional.
//
// Before a turn speaks, the default output device is checked: muted → nothing is spoken, the
// answer card offers Unmute (and the answer is copied when the user asked for that). While a
// screen reader runs, Lumen stays quiet and answers go to the screen reader instead.
import type { TtsMessage } from '@shared/channels'
import { bus } from '../../bus'
import { loadConfig } from '../../config'
import { log } from '../../logger'
import { screenReaderActive } from '../../a11y/at-state'
import * as assistant from '../../windows/assistant'
import * as hud from '../../windows/hud'
import { setStatus } from '../../windows/status'
import { uiV2 } from '../../windows/ui-mode'
import { forTheEar } from './ear'
import { openAiTtsAvailable, synthOpenAi } from './openai'
import { OutputGate, ttsAllowed } from './output'
import { TurnSpeech, ttsEngine } from './turns'
import { WinVoiceHelper } from './win-helper'

const OUTPUT_CHECK_MS = 600

const turns = new TurnSpeech()
const helper = new WinVoiceHelper()
// Bumped on stop; audio from an older generation is dropped.
let generation = 0
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
  hud.send('voice:tts', msg)
}

/** Routes answers to the screen reader (a11y announce); set by main at startup. */
export function setAnswerAnnouncer(fn: (text: string) => void): void {
  announceAnswer = fn
}

export function stopSpeaking(): void {
  generation++
  chain = Promise.resolve()
  send({ op: 'stop' })
}

function onMuted(turnId: string): void {
  log('step', 'tts skipped: sound output is muted')
  mutedTurn = turnId
  if (uiV2()) assistant.setNotice({ text: 'Sound is muted', action: 'unmute' })
  else setStatus('error', 'Sound is muted, so the answer is not read aloud', undefined, 4000)
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
  rate: number
): Promise<{ mime: string; data: string }> {
  return engine === 'cloud'
    ? synthOpenAi(text, voice, rate).then((data) => ({ mime: 'audio/mpeg', data }))
    : helper.synth(text, voice, rate).then((data) => ({ mime: 'audio/wav', data }))
}

function say(text: string, turnId: string): void {
  const cfg = loadConfig()
  const engine = ttsEngine(cfg.voice.tts, openAiTtsAvailable())
  const clean = forTheEar(text)
  if (!engine || !clean) return
  const n = seq++
  const { ttsVoice: voice, ttsRate: rate } = cfg.voice
  const fallback: TtsMessage = { op: 'say', turnId, seq: n, text: clean, voice, rate }
  const checkOutput = helper.usable
  if (engine === 'windows' && !helper.usable) {
    send(fallback)
    return
  }
  // Synthesis starts now; playback order is kept by chaining the sends.
  const gen = generation
  const audio = synth(engine, clean, voice, rate)
  audio.catch(() => {})
  chain = chain.then(async () => {
    if (checkOutput && (await output.mutedFor(turnId))) return
    try {
      const data = await audio
      if (gen === generation) send({ op: 'audio', turnId, seq: n, ...data })
    } catch (e) {
      log('fail', `tts ${engine} failed, using speechSynthesis: ${(e as Error).message}`)
      if (gen === generation) send(fallback)
    }
  })
}

/** Lumen's voice is on and no screen reader is speaking for the user. */
function turnSpeaks(): boolean {
  const cfg = loadConfig()
  if (cfg.voice.tts === 'off') return false
  return ttsAllowed(screenReaderActive(), cfg.voice.ttsWithScreenReader)
}

/** Speaks `text` now (settings preview, announce fallback). During a turn it does nothing. */
export async function speakAnswer(text: string): Promise<void> {
  if (turns.current) return
  if (!ttsEngine(loadConfig().voice.tts, openAiTtsAvailable())) {
    throw new Error('Spoken replies are off')
  }
  stopSpeaking()
  say(text, `preview-${seq}`)
}

/** Starts the Windows voice helper early when spoken replies are on. */
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
