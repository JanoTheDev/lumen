// The offline speech-to-text model: NVIDIA Parakeet TDT-CTC 110M (English, int8), packaged for
// sherpa-onnx. CC-BY-4.0. Picked over Moonshine and Whisper base on accuracy and CPU speed
// (benchmark in the voice plan notes). Downloaded once to ~/.ai-overlay/stt-model/.
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

export const LOCAL_STT_MODEL = {
  id: 'parakeet-tdt-ctc-110m-en-int8',
  sizeMb: 104,
  license: 'CC-BY-4.0',
  archive: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
    sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b',
    rootInArchive: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8',
    requiredFiles: ['model.int8.onnx', 'tokens.txt']
  } satisfies ArchiveSpec
}

export function localModelDir(): string {
  return join(homedir(), '.ai-overlay', 'stt-model', LOCAL_STT_MODEL.id)
}

export function localModelInstalled(): boolean {
  return hasFiles(localModelDir(), LOCAL_STT_MODEL.archive.requiredFiles)
}

let installing: Promise<void> | null = null
let lastProgress: DownloadProgress | null = null

export function localModelProgress(): DownloadProgress | null {
  return installing ? lastProgress : null
}

/** Downloads the model once; concurrent callers share the same install. */
export function installLocalModel(): Promise<void> {
  if (localModelInstalled()) return Promise.resolve()
  if (installing) return installing
  const report = (p: DownloadProgress): void => {
    lastProgress = p
    broadcast('voice:stt-model-progress', p)
  }
  log('step', `downloading offline speech model (${LOCAL_STT_MODEL.sizeMb} MB)`)
  const t0 = Date.now()
  installing = installArchive(LOCAL_STT_MODEL.archive, localModelDir(), report)
    .then(() => log('done', 'offline speech model installed', { timeMs: Date.now() - t0 }))
    .catch((e: Error) => {
      log('fail', `offline speech model install failed: ${e.message}`)
      report({ phase: 'error', message: e.message })
      throw e
    })
    .finally(() => {
      installing = null
    })
  return installing
}
