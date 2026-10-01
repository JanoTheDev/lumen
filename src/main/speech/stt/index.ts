// Speech-to-text entry point: local (sherpa-onnx, free, offline) by default, OpenAI Whisper when
// the user prefers cloud and has a key. Audio arrives as 16 kHz mono WAV from the renderer.
import { toFile } from 'openai'
import type { SttStatus } from '@shared/channels'
import { openaiClient } from '../../ai/providers/openai'
import { loadConfig } from '../../config'
import { log } from '../../logger'
import { chooseStt, wantsLocalModel, type SttAvailability } from './engine'
import { localEngineSupported, transcribeLocal, warmLocalStt } from './local'
import {
  LOCAL_STT_MODEL,
  installLocalModel,
  localModelInstalled,
  localModelProgress
} from './local-model'
import { isWav, parseWav } from './wav'

// Under ~0.3s there is no word to recognise and Whisper tends to hallucinate.
const MIN_AUDIO_SECONDS = 0.3
const MIN_WEBM_BYTES = 6000

export function whisperPrompt(userVocab: string): string {
  const vocab = userVocab.trim()
  const vocabList = vocab
    ? `, ${vocab
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')}`
    : ''
  return `AI assistant voice command. User speaks English. Common words: open, click, email, Gmail, drafts, inbox, reply, compose, send, navigate, GitHub, Lumen, Claude, Anthropic${vocabList}.`
}

// Whisper reads the prompt as preceding text: a punctuated sample nudges it to punctuate,
// and listed names nudge their spelling. Kept well under its 224-token prompt window.
const MAX_PROMPT_TERMS = 60

export function dictationPrompt(dictionary: readonly string[], userVocab = ''): string {
  const extra = userVocab
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const terms = [...new Set([...dictionary.map((d) => d.trim()), ...extra])]
    .filter(Boolean)
    .slice(0, MAX_PROMPT_TERMS)
  const names = terms.length ? ` Names and terms: ${terms.join(', ')}.` : ''
  return `Dictated text, written out with normal punctuation and capital letters.${names}`
}

function availability(): SttAvailability {
  return {
    openaiKey: !!process.env.OPENAI_API_KEY,
    localSupported: localEngineSupported(),
    localInstalled: localModelInstalled()
  }
}

export function sttStatus(): SttStatus {
  const a = availability()
  const pref = loadConfig().voice.stt
  const progress = localModelProgress()
  return {
    pref,
    engine: chooseStt(pref, a).engine,
    localSupported: a.localSupported,
    localInstalled: a.localInstalled,
    installing: !!progress,
    percent: progress?.percent,
    modelSizeMb: LOCAL_STT_MODEL.sizeMb
  }
}

/** At startup: fetch the local model if it will be needed, else load it so the first use is fast. */
export function prepareStt(): void {
  const pref = loadConfig().voice.stt
  const a = availability()
  if (wantsLocalModel(pref, a)) {
    installLocalModel()
      .then(() => {
        if (chooseStt(loadConfig().voice.stt, availability()).engine === 'local') warmLocalStt()
      })
      .catch(() => {})
  } else if (chooseStt(pref, a).engine === 'local') {
    warmLocalStt()
  }
}

function settingUpMessage(): string {
  const p = localModelProgress()
  const pct = p?.phase === 'downloading' && p.percent !== undefined ? ` (${p.percent}%)` : ''
  return `Setting up offline voice${pct}. Try again in a moment.`
}

async function transcribeCloud(audio: ArrayBuffer, dictation: boolean): Promise<string> {
  const wav = isWav(audio)
  const cfg = loadConfig()
  const t0 = Date.now()
  const result = await openaiClient().audio.transcriptions.create(
    {
      // Sent from memory; recordings never touch disk.
      file: await toFile(Buffer.from(audio), wav ? 'recording.wav' : 'recording.webm', {
        type: wav ? 'audio/wav' : 'audio/webm'
      }),
      model: 'whisper-1',
      language: 'en',
      prompt: dictation
        ? dictationPrompt(cfg.dictation.dictionary, cfg.voiceVocab)
        : whisperPrompt(cfg.voiceVocab)
    },
    { timeout: 60000 }
  )
  log('time', 'stt cloud', { timeMs: Date.now() - t0 })
  return result.text
}

export async function transcribe(
  audio: ArrayBuffer,
  opts: { dictation?: boolean } = {}
): Promise<string> {
  const pcm = isWav(audio) ? parseWav(audio) : null
  const seconds = pcm ? pcm.samples.length / pcm.sampleRate : undefined
  if (seconds !== undefined ? seconds < MIN_AUDIO_SECONDS : audio.byteLength < MIN_WEBM_BYTES) {
    log('skip', 'stt: audio too short')
    return ''
  }

  const a = availability()
  const decision = chooseStt(loadConfig().voice.stt, a)
  if (decision.engine === null) {
    if (decision.reason === 'installing') {
      installLocalModel().catch(() => {})
      throw new Error(settingUpMessage())
    }
    throw new Error('Offline voice is not available on this PC. Add an OpenAI key to use voice.')
  }

  if (decision.engine === 'local' && pcm) {
    try {
      return await transcribeLocal(pcm.samples, pcm.sampleRate)
    } catch (e) {
      log('fail', `stt local failed: ${(e as Error).message}`)
      if (!a.openaiKey) throw new Error('Offline speech recognition failed. Please try again.')
    }
  }
  if (!a.openaiKey) throw new Error('Speech recognition needs the offline model or an OpenAI key.')
  return transcribeCloud(audio, !!opts.dictation)
}
