import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import type { ChildProcess } from 'child_process'
import type { SpawnFn } from '../../src/main/agent/bridge'

export type Framing = 'v1' | 'v2'

export interface SentMessage {
  v?: number
  id: number
  cmd: string
  args?: Record<string, unknown>
  [k: string]: unknown
}

export const READY_V2 = {
  v: 2,
  event: 'ready',
  data: { impl: 'python', version: '0.0.0-test', capabilities: ['hotkey', 'input', 'capture'] }
}

export interface FakeChildOptions {
  framing?: Framing
  /** v2 only: emit the ready event on the next microtask (default true). */
  autoReady?: boolean
  /** Answer ping (and init/cancel on v2) automatically (default true). */
  autoPing?: boolean
}

type Responder = unknown | ((msg: SentMessage) => unknown)

/** A stand-in for the agent child process, driven from the test. */
export class FakeChild extends EventEmitter {
  readonly framing: Framing
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  pid: number | undefined = 4242
  killed = false
  /** Raw lines written by the bridge. */
  readonly lines: string[] = []
  /** Parsed lines written by the bridge. */
  readonly received: SentMessage[] = []
  private responders = new Map<string, Responder>()
  private autoPing: boolean
  private partial = ''

  constructor(opts: FakeChildOptions = {}) {
    super()
    this.framing = opts.framing ?? 'v1'
    this.autoPing = opts.autoPing ?? true
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb): void => {
        this.partial += chunk.toString()
        let nl = this.partial.indexOf('\n')
        while (nl !== -1) {
          const line = this.partial.slice(0, nl)
          this.partial = this.partial.slice(nl + 1)
          if (line) this.onLine(line)
          nl = this.partial.indexOf('\n')
        }
        cb()
      }
    })
    if (this.framing === 'v2' && (opts.autoReady ?? true)) {
      queueMicrotask(() => this.emitLine(READY_V2))
    }
  }

  /** Reply to every future `cmd` with `result` (or the return value of a function). */
  respondTo(cmd: string, result: Responder): this {
    this.responders.set(cmd, result)
    return this
  }

  /** Write one JSON line to stdout. */
  emitLine(obj: unknown): void {
    this.emitRaw([Buffer.from(JSON.stringify(obj) + '\n', 'utf8')])
  }

  /** Write raw chunks to stdout exactly as given (use `splitAt` to cut mid-character). */
  emitRaw(chunks: Array<Buffer | string>): void {
    for (const c of chunks) this.stdout.emit('data', typeof c === 'string' ? Buffer.from(c) : c)
  }

  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf8'))
  }

  /** Simulate the process exiting on its own. */
  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emitExit(null, 'SIGTERM'))
    return true
  }

  /** Last message the bridge sent for `cmd`. */
  last(cmd: string): SentMessage | undefined {
    return [...this.received].reverse().find((m) => m.cmd === cmd)
  }

  /** Reply to a specific request in this child's framing. */
  reply(id: number, result: unknown): void {
    this.emitLine(this.framing === 'v2' ? { v: 2, id, ok: true, result } : { id, result })
  }

  replyError(id: number, code: string, message = code): void {
    this.emitLine(
      this.framing === 'v2'
        ? { v: 2, id, ok: false, error: { code, message } }
        : { id, error: message }
    )
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess
  }

  private onLine(line: string): void {
    this.lines.push(line)
    const msg = JSON.parse(line) as SentMessage
    this.received.push(msg)

    if (this.framing === 'v2' && msg.v !== 2) {
      // A real v2 agent rejects v1-framed lines (the bridge's handshake ping).
      queueMicrotask(() => this.replyError(msg.id, 'E_INTERNAL', 'bad frame'))
      return
    }
    if (this.responders.has(msg.cmd)) {
      const r = this.responders.get(msg.cmd)
      const result = typeof r === 'function' ? (r as (m: SentMessage) => unknown)(msg) : r
      queueMicrotask(() => this.reply(msg.id, result))
      return
    }
    if (!this.autoPing) return
    if (msg.cmd === 'ping') {
      queueMicrotask(() => this.reply(msg.id, this.framing === 'v2' ? { t: 1 } : 'pong'))
    } else if (this.framing === 'v2' && (msg.cmd === 'init' || msg.cmd === 'cancel')) {
      queueMicrotask(() => this.reply(msg.id, {}))
    }
  }
}

/** Cut `text` (UTF-8) into chunks at the given byte offsets, e.g. mid-character. */
export function splitAt(text: string, offsets: number[]): Buffer[] {
  const buf = Buffer.from(text, 'utf8')
  const cuts = [...new Set(offsets)].filter((o) => o > 0 && o < buf.length).sort((a, b) => a - b)
  const out: Buffer[] = []
  let start = 0
  for (const c of cuts) {
    out.push(buf.subarray(start, c))
    start = c
  }
  out.push(buf.subarray(start))
  return out
}

/** A spawn function for `new AgentBridge({ spawnFn })` that records every FakeChild it makes. */
export function fakeSpawn(opts: FakeChildOptions | (() => FakeChildOptions) = {}): {
  spawnFn: SpawnFn
  children: FakeChild[]
  latest: () => FakeChild
} {
  const children: FakeChild[] = []
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild(typeof opts === 'function' ? opts() : opts)
    children.push(child)
    return child.asChildProcess()
  }
  return {
    spawnFn,
    children,
    latest: () => {
      const c = children[children.length - 1]
      if (!c) throw new Error('fakeSpawn: nothing spawned yet')
      return c
    }
  }
}

/** Let queued microtasks (auto replies, bridge handlers) run. */
export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}
