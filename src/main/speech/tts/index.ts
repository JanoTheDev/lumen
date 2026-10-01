// Spoken replies. Answers are spoken sentence by sentence as `speech.say-chunk` arrives, so
// speech starts before the reply is finished. Default engine: Windows voices, played by
// speechSynthesis in the voice renderer (free, offline). OpenAI voices are optional.
import type { TtsMessage } from '@shared/channels'
import { bus } from '../../bus'
import { loadConfig } from '../../config'
import { log } from '../../logger'
import * as hud from '../../windows/hud'
import { forTheEar } from './ear'
import { openAiTtsAvailable, synthOpenAi } from './openai'
import { TurnSpeech, ttsEngine } from './turns'

const turns = new TurnSpeech()
// Bumped on stop; cloud audio from an older generation is dropped.
let generation = 0
let seq = 0
let cloudChain: Promise<void> = Promise.resolve()

function send(msg: TtsMessage): void {
  hud.send('voice:tts', msg)
}

export function stopSpeaking(): void {
  generation++
  cloudChain = Promise.resolve()
  send({ op: 'stop' })
}

function say(text: string, turnId: string): void {
  const cfg = loadConfig()
  const engine = ttsEngine(cfg.voice.tts, openAiTtsAvailable())
  const clean = forTheEar(text)
  if (!engine || !clean) return
  const n = seq++
  const { ttsVoice: voice, ttsRate: rate } = cfg.voice
  if (engine === 'windows') {
    send({ op: 'say', turnId, seq: n, text: clean, voice, rate })
    return
  }
  // Synthesis starts now; playback order is kept by chaining the sends.
  const gen = generation
  const audio = synthOpenAi(clean, voice, rate)
  cloudChain = cloudChain.then(async () => {
    try {
      const data = await audio
      if (gen === generation) send({ op: 'audio', turnId, seq: n, mime: 'audio/mpeg', data })
    } catch (e) {
      log('fail', `tts cloud failed, using a Windows voice: ${(e as Error).message}`)
      if (gen === generation) send({ op: 'say', turnId, seq: n, text: clean, voice, rate })
    }
  })
}

/** Speaks `text` now (settings preview). During a turn it does nothing: the turn speaks itself. */
export async function speakAnswer(text: string): Promise<void> {
  if (turns.current) return
  if (!ttsEngine(loadConfig().voice.tts, openAiTtsAvailable())) {
    throw new Error('Spoken replies are off')
  }
  stopSpeaking()
  say(text, 'preview')
}

bus.on('query.started', ({ turnId }) => {
  stopSpeaking()
  turns.start(turnId)
})
bus.on('speech.say-chunk', ({ turnId, text }) => {
  turns.markSpoken(turnId)
  say(text, turnId)
})
bus.on('query.done', ({ turnId, response }) => {
  turns.end(turnId)
  // Replies that were not streamed (plans, fallbacks) are spoken whole once they are done.
  if (turns.hasSpoken(turnId) || response.mode !== 'answer') return
  const text = (response.spoken ?? response.text ?? '').trim()
  if (text) say(text, turnId)
})
bus.on('query.failed', ({ turnId }) => turns.end(turnId))
bus.on('query.cancelled', ({ turnId }) => {
  turns.end(turnId)
  stopSpeaking()
})
// The user starting to talk silences Lumen (hotkey barge-in).
bus.on('voice.started', () => stopSpeaking())
bus.on('voice.cancelled', () => stopSpeaking())
bus.on('dictation.started', () => stopSpeaking())
