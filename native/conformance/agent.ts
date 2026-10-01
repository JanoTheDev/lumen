// Spawns lumen-native and speaks protocol v2 to it.
//
// LUMEN_AGENT_CMD overrides the command, e.g.
//   native/target/fastrel/lumen-native.exe --debug
// Relative paths resolve against the repo root. Default: the native release build.
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { isAbsolute, join, resolve } from 'path'
import { StringDecoder } from 'string_decoder'

export const REPO = resolve(__dirname, '..', '..')

export type Frame = Record<string, unknown> & {
  v?: number
  id?: unknown
  ok?: boolean
  event?: string
  data?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

function splitCommand(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2])
  return out
}

export function agentCommand(): string[] {
  const env = process.env.LUMEN_AGENT_CMD?.trim()
  if (env) {
    const [exe, ...args] = splitCommand(env)
    const abs = isAbsolute(exe) || !/[\\/]/.test(exe) ? exe : join(REPO, exe)
    return [abs, ...args.map((a) => (/^native[\\/]/.test(a) ? join(REPO, a) : a))]
  }
  return [join(REPO, 'native', 'target', 'release', 'lumen-native.exe'), '--debug']
}

export class Agent {
  readonly proc: ChildProcessWithoutNullStreams
  readonly frames: Frame[] = []
  readonly raw: string[] = []
  readonly stderr: string[] = []
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private waiters: Array<() => void> = []
  private nextId = 1000
  ready!: { impl: string; version: string; capabilities: string[] }

  private constructor(extraArgs: string[]) {
    const [exe, ...args] = agentCommand()
    this.proc = spawn(exe, [...args, ...extraArgs], {
      cwd: REPO,
      env: process.env,
      windowsHide: true
    })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(this.decoder.write(chunk)))
    this.proc.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')))
  }

  static async start(...extraArgs: string[]): Promise<Agent> {
    const a = new Agent(extraArgs)
    const first = await a.waitFor(() => true, 20_000)
    if (first.event !== 'ready')
      throw new Error(`first frame is not ready: ${JSON.stringify(first)}`)
    a.ready = first.data as Agent['ready']
    return a
  }

  private onData(text: string): void {
    this.buffer += text
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      this.raw.push(line)
      this.frames.push(JSON.parse(line) as Frame)
    }
    this.waiters.splice(0).forEach((w) => w())
  }

  has(cap: string): boolean {
    return this.ready.capabilities.includes(cap)
  }

  send(obj: unknown): void {
    this.proc.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n')
  }

  /** Resolves with the first frame (seen so far or later) matching `pred`, consuming nothing. */
  waitFor(pred: (f: Frame) => boolean, timeoutMs = 10_000, from = 0): Promise<Frame> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        rej(
          new Error(`timeout waiting for frame; stderr tail:\n${this.stderr.join('').slice(-2000)}`)
        )
      }, timeoutMs)
      const check = (): void => {
        const hit = this.frames.slice(from).find(pred)
        if (hit) {
          clearTimeout(timer)
          res(hit)
        } else this.waiters.push(check)
      }
      check()
    })
  }

  async request(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15_000
  ): Promise<Frame> {
    const id = this.nextId++
    this.send({ v: 2, id, cmd, args })
    return this.waitFor((f) => f.id === id && f.event === undefined, timeoutMs)
  }

  /** Request that must succeed; returns its result. */
  async ok<T = Record<string, unknown>>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    const f = await this.request(cmd, args, timeoutMs)
    if (f.ok !== true) throw new Error(`${cmd} failed: ${JSON.stringify(f.error)}`)
    return f.result as T
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) return this.proc.exitCode
    const exited = new Promise<number | null>((res) => this.proc.once('exit', (code) => res(code)))
    this.proc.stdin.end()
    const timer = setTimeout(() => this.proc.kill(), 10_000)
    const code = await exited
    clearTimeout(timer)
    return code
  }
}
