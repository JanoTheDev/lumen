// Worker-thread entry for sherpa-onnx. Building the keyword spotter takes seconds of
// synchronous ONNX work and every 100 ms mic block runs a decode, so none of it may run on
// Electron's main thread (measured: scripts/bench-sherpa.mjs).
import { parentPort, workerData } from 'worker_threads'
import { createEngine, type EngineEvent, type EngineRequest, type Sherpa } from './sherpa-engine'

// Only acts when started by sherpa.ts; importing it elsewhere (tests resolving `?modulePath`,
// possibly on a test-runner thread) does nothing.
const port = (workerData as { sherpa?: boolean } | null)?.sherpa ? parentPort : null
if (port) {
  let lib: Sherpa | null = null
  let error: string | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('sherpa-onnx-node') as Sherpa
  } catch (e) {
    error = (e as Error).message.split('\n')[0]
  }
  const post = (e: EngineEvent, transfer: ArrayBuffer[] = []): void => port.postMessage(e, transfer)
  const engine = createEngine(lib, post)
  port.on('message', (msg: EngineRequest) => engine.handle(msg))
  post({ t: 'ready', supported: !!lib, error })
}
