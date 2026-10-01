// Offline transcription with sherpa-onnx. The recognizer is created once (about 1.5s) and
// decodes on a native worker thread, so the main process never blocks.
import { cpus } from 'os'
import { join } from 'path'
import type { OfflineRecognizer } from 'sherpa-onnx-node'
import { log } from '../../logger'
import { localModelDir, localModelInstalled } from './local-model'

type Sherpa = typeof import('sherpa-onnx-node')

let sherpa: Sherpa | null | undefined
let recognizer: Promise<OfflineRecognizer> | null = null

function loadSherpa(): Sherpa | null {
  if (sherpa !== undefined) return sherpa
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as Sherpa
  } catch (e) {
    log('fail', `local speech engine unavailable: ${(e as Error).message.split('\n')[0]}`)
    sherpa = null
  }
  return sherpa
}

/** True when the native engine loads on this machine (model may still need downloading). */
export function localEngineSupported(): boolean {
  return loadSherpa() !== null
}

export function localSttReady(): boolean {
  return localModelInstalled() && localEngineSupported()
}

function threads(): number {
  return Math.min(4, Math.max(1, Math.floor(cpus().length / 4)))
}

function getRecognizer(): Promise<OfflineRecognizer> {
  if (recognizer) return recognizer
  const lib = loadSherpa()
  if (!lib) return Promise.reject(new Error('Offline speech engine is not available'))
  const dir = localModelDir()
  const t0 = Date.now()
  recognizer = lib.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      nemoCtc: { model: join(dir, 'model.int8.onnx') },
      tokens: join(dir, 'tokens.txt'),
      numThreads: threads(),
      provider: 'cpu',
      debug: 0
    },
    decodingMethod: 'greedy_search'
  })
  recognizer.then(
    () => log('time', 'local stt model loaded', { timeMs: Date.now() - t0 }),
    (e: Error) => {
      log('fail', `local stt model failed to load: ${e.message}`)
      recognizer = null
    }
  )
  return recognizer
}

/** Loads the model ahead of the first utterance. Safe to call repeatedly. */
export function warmLocalStt(): void {
  if (localSttReady()) getRecognizer().catch(() => {})
}

export async function transcribeLocal(samples: Float32Array, sampleRate: number): Promise<string> {
  const rec = await getRecognizer()
  const stream = rec.createStream()
  stream.acceptWaveform({ samples, sampleRate })
  const t0 = Date.now()
  const { text } = await rec.decodeAsync(stream)
  const secs = samples.length / sampleRate
  log('time', `stt local ${secs.toFixed(1)}s audio`, { timeMs: Date.now() - t0 })
  return text.trim()
}
