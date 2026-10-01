// The offline speech-to-text models, packaged for sherpa-onnx, downloaded once to
// ~/.ai-overlay/stt-model/<id>/:
//   - English (and the default): NVIDIA Parakeet TDT-CTC 110M int8, CC-BY-4.0. Picked over
//     Moonshine and Whisper base on accuracy and CPU speed (benchmark in the voice plan notes).
//   - Spanish, German, French: NVIDIA Canary 180M flash int8 (en/es/de/fr), CC-BY-4.0. Needs the
//     spoken language up front (it would translate otherwise), so it serves a fixed language.
// The voice language (config voice.language) picks the model; other languages have no offline
// model and use OpenAI when a key exists.
import { homedir } from 'os'
import { join } from 'path'
import { loadConfig } from '../../config'
import { broadcast } from '../../windows/registry'
import { log } from '../../logger'
import {
  hasFiles,
  installArchive,
  type ArchiveSpec,
  type DownloadProgress
} from '../models/download'

export type SttModelKind = 'nemo-ctc' | 'canary'

export interface LocalSttModel {
  id: string
  kind: SttModelKind
  sizeMb: number
  license: string
  /** Spoken languages it transcribes. */
  langs: readonly string[]
  archive: ArchiveSpec
}

export const PARAKEET_EN: LocalSttModel = {
  id: 'parakeet-tdt-ctc-110m-en-int8',
  kind: 'nemo-ctc',
  sizeMb: 104,
  license: 'CC-BY-4.0',
  langs: ['en'],
  archive: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
    sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b',
    rootInArchive: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8',
    requiredFiles: ['model.int8.onnx', 'tokens.txt']
  }
}

export const CANARY_MULTI: LocalSttModel = {
  id: 'canary-180m-flash-en-es-de-fr-int8',
  kind: 'canary',
  sizeMb: 154,
  license: 'CC-BY-4.0',
  langs: ['en', 'es', 'de', 'fr'],
  archive: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2',
    sha256: '7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9',
    rootInArchive: 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8',
    requiredFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
  }
}

/** The offline model for a voice language: Canary for es/de/fr, else Parakeet (English). */
export function sttModelFor(lang: string | undefined): LocalSttModel {
  const base = (lang ?? 'en').toLowerCase().split('-')[0]
  return base !== 'en' && CANARY_MULTI.langs.includes(base) ? CANARY_MULTI : PARAKEET_EN
}

/** The voice language can be transcribed offline (auto means English offline). */
export function offlineLanguage(lang: string | undefined): boolean {
  const base = (lang ?? 'en').toLowerCase().split('-')[0]
  return base === 'auto' || CANARY_MULTI.langs.includes(base)
}

export function currentSttModel(): LocalSttModel {
  return sttModelFor(loadConfig().voice.language)
}

export function localModelDir(model: LocalSttModel = currentSttModel()): string {
  return join(homedir(), '.ai-overlay', 'stt-model', model.id)
}

export function localModelInstalled(model: LocalSttModel = currentSttModel()): boolean {
  return hasFiles(localModelDir(model), model.archive.requiredFiles)
}

const installing = new Map<string, Promise<void>>()
let lastProgress: DownloadProgress | null = null

export function localModelProgress(): DownloadProgress | null {
  return installing.size ? lastProgress : null
}

/** Downloads a model once; concurrent callers share the same install. */
export function installLocalModel(model: LocalSttModel = currentSttModel()): Promise<void> {
  if (localModelInstalled(model)) return Promise.resolve()
  const running = installing.get(model.id)
  if (running) return running
  const report = (p: DownloadProgress): void => {
    lastProgress = p
    broadcast('voice:stt-model-progress', p)
  }
  log('step', `downloading offline speech model ${model.id} (${model.sizeMb} MB)`)
  const t0 = Date.now()
  const job = installArchive(model.archive, localModelDir(model), report)
    .then(() => log('done', 'offline speech model installed', { timeMs: Date.now() - t0 }))
    .catch((e: Error) => {
      log('fail', `offline speech model install failed: ${e.message}`)
      report({ phase: 'error', message: e.message })
      throw e
    })
    .finally(() => {
      installing.delete(model.id)
    })
  installing.set(model.id, job)
  return job
}
