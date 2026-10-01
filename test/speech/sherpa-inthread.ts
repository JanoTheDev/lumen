// Runs the sherpa speech engine on the test thread behind the worker interface, so tests
// exercise main's message API without bundling the worker entry.
import { EventEmitter } from 'events'
import { createEngine, type EngineEvent, type Sherpa } from '../../src/main/speech/sherpa-engine'
import type { SherpaWorker } from '../../src/main/speech/sherpa'

export class InThreadWorker extends EventEmitter implements SherpaWorker {
  readonly sent: unknown[] = []
  private readonly engine

  constructor(lib: Sherpa | null) {
    super()
    const post = (e: EngineEvent): void => {
      setImmediate(() => this.emit('message', e))
    }
    this.engine = createEngine(lib, post)
    post({ t: 'ready', supported: !!lib, error: lib ? undefined : 'not loaded' })
  }

  postMessage(msg: Parameters<SherpaWorker['postMessage']>[0]): void {
    this.sent.push(msg)
    setImmediate(() => this.engine.handle(msg))
  }

  terminated = false
  terminate(): void {
    this.terminated = true
  }
}

export function loadAddon(): Sherpa | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sherpa-onnx-node') as Sherpa
  } catch {
    return null
  }
}
