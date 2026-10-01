// The wake-word model: sherpa-onnx keyword spotter, zipformer trained on GigaSpeech (3.3M
// params, Apache-2.0, English, open vocabulary). 17.6 MB download, installed once to
// ~/.ai-overlay/wake-model/. Picked over Vosk grammar mode: 0/90 false wakes vs 45/90 at the
// same recall (evaluation in the voice plan notes).
import { homedir } from 'os'
import { join } from 'path'
import { broadcast } from '../../windows/registry'
import { log } from '../../logger'
import {
  hasFiles,
  installArchive,
  type ArchiveSpec,
  type DownloadProgress
} from '../models/download'

const ROOT = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'

export const KWS_MODEL = {
  id: 'kws-zipformer-gigaspeech-3.3M',
  sizeMb: 18,
  license: 'Apache-2.0',
  files: {
    encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    tokens: 'tokens.txt',
    pieces: 'bpe.model'
  },
  archive: {
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${ROOT}.tar.bz2`,
    sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
    rootInArchive: ROOT,
    requiredFiles: [
      'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
      'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'tokens.txt',
      'bpe.model'
    ]
  } satisfies ArchiveSpec
}

export function kwsModelDir(): string {
  return join(homedir(), '.ai-overlay', 'wake-model', KWS_MODEL.id)
}

export function kwsModelInstalled(): boolean {
  return hasFiles(kwsModelDir(), KWS_MODEL.archive.requiredFiles)
}

let installing: Promise<void> | null = null

export function kwsModelInstalling(): boolean {
  return installing !== null
}

/** Downloads the model once; concurrent callers share the install. Progress goes to Settings. */
export function installKwsModel(): Promise<void> {
  if (kwsModelInstalled()) return Promise.resolve()
  if (installing) return installing
  const report = (p: DownloadProgress): void => broadcast('wake:model-progress', p)
  log('step', `downloading wake word model (${KWS_MODEL.sizeMb} MB)`)
  const t0 = Date.now()
  installing = installArchive(KWS_MODEL.archive, kwsModelDir(), report)
    .then(() => log('done', 'wake word model installed', { timeMs: Date.now() - t0 }))
    .catch((e: Error) => {
      log('fail', `wake word model install failed: ${e.message}`)
      report({ phase: 'error', message: e.message })
      throw e
    })
    .finally(() => {
      installing = null
    })
  return installing
}
