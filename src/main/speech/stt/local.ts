// Offline transcription with sherpa-onnx. The recognizer lives in the speech worker (loaded
// once, about 1.5 s) and decodes there, so the main process never blocks.
import { cpus } from 'os'
import { loadSherpa, sherpaRequest } from '../sherpa'
import type { SttModel } from '../sherpa-engine'
import { localModelDir, localModelInstalled } from './local-model'

/** True unless the native engine is known not to load here (model may still need downloading). */
export function localEngineSupported(): boolean {
  return loadSherpa()
}

export function localSttReady(): boolean {
  return localModelInstalled() && localEngineSupported()
}

function model(): SttModel {
  return { dir: localModelDir(), threads: Math.min(4, Math.max(1, Math.floor(cpus().length / 4))) }
}

/** Loads the model ahead of the first utterance. Safe to call repeatedly. */
export function warmLocalStt(): void {
  if (localSttReady()) sherpaRequest({ t: 'stt-warm', model: model() }).catch(() => {})
}

export function transcribeLocal(samples: Float32Array, sampleRate: number): Promise<string> {
  return sherpaRequest<string>({ t: 'stt', model: model(), samples, sampleRate })
}
