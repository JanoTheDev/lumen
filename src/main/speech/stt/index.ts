// Speech-to-text entry point: local (sherpa-onnx, free, offline) by default, OpenAI Whisper when
// the user prefers cloud and has a key. Audio arrives as 16 kHz mono WAV from the renderer.
// The voice language (config voice.language) picks the offline model and tells Whisper what
// it hears.
import { toFile } from 'openai'
import type { SttStatus } from '@shared/channels'
import { openaiClient } from '../../ai/providers/openai'
import { loadConfig, type AppConfig } from '../../config'
import { log } from '../../logger'
import { voiceLatency } from '../latency'
import { chooseStt, wantsLocalModel, type SttAvailability } from './engine'
import { foregroundTerms } from './foreground-vocab'
import { localEngineSupported, transcribeLocal, warmLocalStt } from './local'
import {
  currentSttModel,
  installLocalModel,
  localModelInstalled,
  localModelProgress,
  offlineLanguage
} from './local-model'
import { mergeVocabulary, splitTerms } from './vocabulary'
import { isWav, parseWav } from './wav'

// Under ~0.3s there is no word to recognise and Whisper tends to hallucinate.
const MIN_AUDIO_SECONDS = 0.3
const MIN_WEBM_BYTES = 6000

const BASE_TERMS = ['Lumen', 'Claude', 'Anthropic', 'GitHub', 'Gmail']

/** The language Whisper is told (undefined = detect). */
export function whisperLanguage(lang: string): string | undefined {
  return lang === 'auto' ? undefined : lang
}

/**
 * Prompt for a spoken request. Whisper reads it as preceding text, so outside English it only
 * lists names (an English sentence would pull the transcript towards English).
 */
export function whisperPrompt(terms: readonly string[], lang = 'en'): string {
  const names = mergeVocabulary([terms, BASE_TERMS])
  if (lang !== 'en') return `${names.join(', ')}.`
  return `AI assistant voice command. User speaks English. Common words: open, click, email, drafts, inbox, reply, compose, send, navigate, ${names.join(', ')}.`
}

/** Dictation: a punctuated sample nudges Whisper to punctuate; listed names nudge spelling. */
export function dictationPrompt(terms: readonly string[], lang = 'en'): string {
  const list = mergeVocabulary([terms])
  if (lang !== 'en') return list.length ? `${list.join(', ')}.` : ''
  const names = list.length ? ` Names and terms: ${list.join(', ')}.` : ''
  return `Dictated text, written out with normal punctuation and capital letters.${names}`
}

/** User vocabulary, then the personal dictionary, then the glossary of the app in front. */
export function sttTerms(
  cfg: Pick<AppConfig, 'voiceVocab' | 'dictation'>,
  appTerms: readonly string[] = foregroundTerms()
): string[] {
  return mergeVocabulary([splitTerms(cfg.voiceVocab), cfg.dictation.dictionary, appTerms])
}

function availability(): SttAvailability {
  return {
    openaiKey: !!process.env.OPENAI_API_KEY,
    localSupported: localEngineSupported(),
    localInstalled: localModelInstalled(),
    localLanguage: offlineLanguage(loadConfig().voice.language)
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
    modelSizeMb: currentSttModel().sizeMb
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

const LANGUAGE_NAMES: Record<string, string> = { it: 'Italian', pt: 'Portuguese', nl: 'Dutch' }

function languageMessage(): string {
  const name = LANGUAGE_NAMES[loadConfig().voice.language] ?? 'this language'
  return `Offline voice does not understand ${name} yet. Add an OpenAI key, or pick English, Spanish, German or French in Settings.`
}

async function transcribeCloud(audio: ArrayBuffer, dictation: boolean): Promise<string> {
  const wav = isWav(audio)
  const cfg = loadConfig()
  const lang = cfg.voice.language
  const terms = sttTerms(cfg)
  const t0 = Date.now()
  const result = await openaiClient().audio.transcriptions.create(
    {
      // Sent from memory; recordings never touch disk.
      file: await toFile(Buffer.from(audio), wav ? 'recording.wav' : 'recording.webm', {
        type: wav ? 'audio/wav' : 'audio/webm'
      }),
      model: 'whisper-1',
      language: whisperLanguage(lang),
      prompt: dictation ? dictationPrompt(terms, lang) : whisperPrompt(terms, lang)
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
  const text = await transcribeAudio(audio, opts)
  voiceLatency.mark('stt-final')
  return text
}

async function transcribeAudio(audio: ArrayBuffer, opts: { dictation?: boolean }): Promise<string> {
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
    if (decision.reason === 'language') throw new Error(languageMessage())
    throw new Error('Offline voice is not available on this PC. Add an OpenAI key to use voice.')
  }

  const localReady = a.localSupported && a.localInstalled && a.localLanguage !== false
  if (decision.engine === 'local' && pcm) {
    try {
      return await transcribeLocal(pcm.samples, pcm.sampleRate)
    } catch (e) {
      log('fail', `stt local failed: ${(e as Error).message}`)
      if (!a.openaiKey) throw new Error('Offline speech recognition failed. Please try again.')
    }
  }
  if (!a.openaiKey) throw new Error('Speech recognition needs the offline model or an OpenAI key.')
  try {
    return await transcribeCloud(audio, !!opts.dictation)
  } catch (e) {
    // Network gone mid-request: the offline model still has the audio.
    if (decision.engine !== 'cloud' || !localReady || !pcm) throw e
    log('fail', `stt cloud failed, using the offline model: ${(e as Error).message}`)
    return transcribeLocal(pcm.samples, pcm.sampleRate)
  }
}
