// The speech engine that runs inside the sherpa worker thread: the wake/cancel keyword spotter
// and the offline recognizer. Kept free of electron and of the main-process logger so the
// worker can load it; tests drive it in-thread through the same messages.
import { join } from 'path'
import type { OfflineRecognizer } from 'sherpa-onnx-node'
import type { KeywordPhrases, SpottedPhrase } from './wake/keywords'
import { Spotter } from './wake/spotter'

export type Sherpa = typeof import('sherpa-onnx-node')

export interface SttModel {
  dir: string
  threads: number
}

/** Main → worker. Requests with an `id` get exactly one `reply`. */
export type EngineRequest =
  | { t: 'spotter'; id: number; dir: string; phrases: KeywordPhrases }
  | { t: 'spotter-off' }
  | { t: 'feed'; pcm: ArrayBuffer }
  | { t: 'recent'; id: number }
  | { t: 'stt-warm'; id: number; model: SttModel }
  | { t: 'stt'; id: number; model: SttModel; samples: Float32Array; sampleRate: number }

/** Worker → main. */
export type EngineEvent =
  | { t: 'ready'; supported: boolean; error?: string }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'hits'; hits: SpottedPhrase[] }
  | { t: 'log'; tag: 'time' | 'fail'; message: string; timeMs?: number }

export interface SpotterBuilt {
  unusable: string[]
}

type Post = (e: EngineEvent, transfer?: ArrayBuffer[]) => void

export interface Engine {
  handle(msg: EngineRequest): void
}

/** `lib` is null when the native addon did not load: every request is answered with an error. */
export function createEngine(lib: Sherpa | null, post: Post): Engine {
  let spotter: Spotter | null = null
  let recognizer: { key: string; rec: Promise<OfflineRecognizer> } | null = null

  const reply = (id: number, work: () => unknown): void => {
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          const transfer = value instanceof Float32Array ? [value.buffer as ArrayBuffer] : []
          post({ t: 'reply', id, ok: true, value }, transfer)
        },
        (e: Error) => post({ t: 'reply', id, ok: false, error: e.message })
      )
  }

  function getRecognizer(m: SttModel): Promise<OfflineRecognizer> {
    if (!lib) return Promise.reject(new Error('Offline speech engine is not available'))
    const key = `${m.dir}|${m.threads}`
    if (recognizer?.key === key) return recognizer.rec
    const t0 = Date.now()
    const rec = lib.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        nemoCtc: { model: join(m.dir, 'model.int8.onnx') },
        tokens: join(m.dir, 'tokens.txt'),
        numThreads: m.threads,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
    const entry = { key, rec }
    recognizer = entry
    rec.then(
      () =>
        post({ t: 'log', tag: 'time', message: 'local stt model loaded', timeMs: Date.now() - t0 }),
      (e: Error) => {
        post({ t: 'log', tag: 'fail', message: `local stt model failed to load: ${e.message}` })
        if (recognizer === entry) recognizer = null
      }
    )
    return rec
  }

  async function transcribe(m: SttModel, samples: Float32Array, rate: number): Promise<string> {
    const rec = await getRecognizer(m)
    const stream = rec.createStream()
    stream.acceptWaveform({ samples, sampleRate: rate })
    const t0 = Date.now()
    const { text } = await rec.decodeAsync(stream)
    const secs = (samples.length / rate).toFixed(1)
    post({ t: 'log', tag: 'time', message: `stt local ${secs}s audio`, timeMs: Date.now() - t0 })
    return text.trim()
  }

  return {
    handle(msg) {
      switch (msg.t) {
        case 'spotter':
          return reply(msg.id, (): SpotterBuilt => {
            if (!lib) throw new Error('Offline speech engine is not available')
            // Built before the swap: audio keeps reaching the old spotter until this one works.
            const next = new Spotter(lib, msg.dir, msg.phrases)
            spotter = next
            return { unusable: next.unusable }
          })
        case 'spotter-off':
          spotter = null
          return
        case 'feed': {
          const hits = spotter?.feed(new Int16Array(msg.pcm)) ?? []
          if (hits.length) post({ t: 'hits', hits })
          return
        }
        case 'recent':
          return reply(msg.id, () => spotter?.recentAudio() ?? null)
        case 'stt-warm':
          return reply(msg.id, () => getRecognizer(msg.model).then(() => null))
        case 'stt':
          return reply(msg.id, () => transcribe(msg.model, msg.samples, msg.sampleRate))
      }
    }
  }
}
