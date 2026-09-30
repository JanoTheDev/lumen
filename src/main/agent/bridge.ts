import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AgentAction } from '../actions/agent-action'
import type { AgentInitArgs } from './state'

export type AgentErrorCode =
  | 'E_AGENT_EXIT'
  | 'E_AGENT_STOPPED'
  | 'E_AGENT_NOT_RUNNING'
  | 'E_AGENT_EPIPE'
  | 'E_AGENT_TIMEOUT'
  | 'E_AGENT_CMD'
  | 'E_TIMEOUT'
  | 'E_CANCELLED'
  | 'E_NOT_FOUND'
  | 'E_DENIED'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL'
  | (string & {})

export class AgentError extends Error {
  constructor(
    public code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export type AgentProtocol = 1 | 2

export interface AgentInfo {
  impl: string
  version: string
  capabilities: string[]
}

export interface RestartPolicy {
  baseMs: number
  maxMs: number
  maxRestarts: number
  windowMs: number
}

export interface AgentBridgeOptions {
  spawnFn?: SpawnFn
  // Runs after every successful (re)start; use it to re-send hotkey, listener and dwell state.
  // On a v2 agent it is skipped when initArgs is set, since `init` carries the full state.
  initState?: () => Promise<void>
  // v2 only: state sent as the `init` command after every ready handshake.
  initArgs?: () => AgentInitArgs | Promise<AgentInitArgs>
  restart?: Partial<RestartPolicy>
}

export interface RequestOptions {
  timeoutMs?: number
  // Aborting rejects with E_CANCELLED and, on v2, sends `cancel` for the in-flight id.
  signal?: AbortSignal
}

type EventHandler = (data?: Record<string, unknown>) => void

interface PendingCall {
  cmd: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WireMessage {
  v?: number
  id?: number
  ok?: boolean
  result?: unknown
  error?: unknown
  event?: string
  data?: unknown
}

const DEFAULT_TIMEOUT_MS = 15000
const CMD_TIMEOUT_MS: Record<string, number> = {
  screenshot: 5000,
  capture: 10000,
  wake_enable: 30000,
  init: 30000,
  cancel: 5000
}
const LONG_ACTION_TIMEOUT_MS = 60000
const LONG_ACTIONS = new Set(['type', 'scroll'])
const LONG_INPUT_STEPS = new Set(['type', 'wait', 'drag'])

const DEFAULT_RESTART: RestartPolicy = {
  baseMs: 500,
  maxMs: 30000,
  maxRestarts: 5,
  windowMs: 60000
}

const QUIET_EVENTS = new Set(['mouse-moved', 'dwell-progress'])

function timeoutFor(cmd: string, params: Record<string, unknown>): number {
  if (cmd === 'execute') {
    const type = (params.action as { type?: string } | undefined)?.type
    return type && LONG_ACTIONS.has(type) ? LONG_ACTION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  }
  if (cmd === 'input') {
    const steps = Array.isArray(params.steps) ? (params.steps as { t?: string }[]) : []
    return steps.some((s) => s && LONG_INPUT_STEPS.has(s.t ?? ''))
      ? LONG_ACTION_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS
  }
  return CMD_TIMEOUT_MS[cmd] ?? DEFAULT_TIMEOUT_MS
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseInfo(data: unknown): AgentInfo {
  const d = isRecord(data) ? data : {}
  return {
    impl: typeof d.impl === 'string' ? d.impl : 'unknown',
    version: typeof d.version === 'string' ? d.version : '0.0.0',
    capabilities: Array.isArray(d.capabilities)
      ? d.capabilities.filter((c): c is string => typeof c === 'string')
      : []
  }
}

export class AgentBridge {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingCall>()
  private idCounter = 0
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private scanFrom = 0
  private eventHandlers: Record<string, EventHandler[]> = {}
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimes: number[] = []
  private spawnFn: SpawnFn
  private initState?: () => Promise<void>
  private initArgs?: () => AgentInitArgs | Promise<AgentInitArgs>
  private restartPolicy: RestartPolicy
  private proto: AgentProtocol = 1
  private info: AgentInfo | null = null
  private onReady: (() => void) | null = null
  private handshakePingId: number | null = null

  constructor(opts: AgentBridgeOptions = {}) {
    this.spawnFn = opts.spawnFn ?? (spawn as SpawnFn)
    this.initState = opts.initState
    this.initArgs = opts.initArgs
    this.restartPolicy = { ...DEFAULT_RESTART, ...opts.restart }
  }

  setInitState(fn: () => Promise<void>): void {
    this.initState = fn
  }

  setInitArgs(fn: () => AgentInitArgs | Promise<AgentInitArgs>): void {
    this.initArgs = fn
  }

  onEvent(event: string, cb: EventHandler): void {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = []
    this.eventHandlers[event].push(cb)
  }

  get running(): boolean {
    return this.proc !== null
  }

  /** Wire framing of the current agent: 2 once it sent the v2 ready event, else 1. */
  get protocol(): AgentProtocol {
    return this.proto
  }

  get impl(): string | null {
    return this.info?.impl ?? null
  }

  get version(): string | null {
    return this.info?.version ?? null
  }

  get capabilities(): string[] {
    return this.info ? [...this.info.capabilities] : []
  }

  get agentInfo(): AgentInfo | null {
    return this.info ? { ...this.info, capabilities: [...this.info.capabilities] } : null
  }

  hasCapability(name: string): boolean {
    return !!this.info?.capabilities.includes(name)
  }

  async start(): Promise<void> {
    this.stopping = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.launch()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const proc = this.proc
    this.proc = null
    this.resetStream()
    this.rejectAll('E_AGENT_STOPPED', 'Agent stopped')
    proc?.kill()
  }

  /** Sends a command in the agent's framing and resolves with its result. */
  request<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: RequestOptions = {}
  ): Promise<T> {
    return this.call(cmd, args, opts) as Promise<T>
  }

  /** v2 only: asks the agent to abort the in-flight command `targetId`. */
  async cancel(targetId: number): Promise<void> {
    if (this.proto !== 2) throw new AgentError('E_UNSUPPORTED', 'cancel needs agent protocol v2')
    await this.call('cancel', { target: targetId })
  }

  async screenshot(): Promise<string> {
    if (this.proto === 2) {
      const res = (await this.call('capture', { monitor: 'primary' })) as {
        frames?: { data?: string }[]
      }
      const data = res?.frames?.[0]?.data
      if (typeof data !== 'string') throw new AgentError('E_INTERNAL', 'capture returned no frame')
      return data
    }
    return this.call('screenshot', {}) as Promise<string>
  }

  async activeWindow(): Promise<string> {
    if (this.proto === 2) {
      const res = (await this.call('active_window', {})) as { title?: unknown }
      return typeof res?.title === 'string' ? res.title : 'Unknown'
    }
    return this.call('active_window', {}) as Promise<string>
  }

  async execute(action: AgentAction): Promise<unknown> {
    if (action.type === 'open_url') return
    return this.call('execute', { action })
  }

  async setHotkey(combo: string): Promise<unknown> {
    return this.call('set_hotkey', { combo })
  }

  async enableListener(phrase: string, cancelPhrases: string[]): Promise<unknown> {
    return this.call('wake_enable', { phrase, cancel_phrases: cancelPhrases })
  }

  async disableListener(): Promise<unknown> {
    return this.call('wake_disable', {})
  }

  async enableDwell(dwellMs: number, cooldownMs: number): Promise<unknown> {
    return this.call('dwell_enable', { dwell_ms: dwellMs, cooldown_ms: cooldownMs })
  }

  async disableDwell(): Promise<unknown> {
    return this.call('dwell_disable', {})
  }

  private async launch(): Promise<void> {
    const agentDir = is.dev ? join(app.getAppPath(), 'agent') : join(process.resourcesPath, 'agent')
    const venvPython =
      process.platform === 'win32'
        ? join(agentDir, '.venv', 'Scripts', 'python.exe')
        : join(agentDir, '.venv', 'bin', 'python3')

    this.resetStream()
    this.proto = 1
    this.info = null
    const proc = this.spawnFn(venvPython, [join(agentDir, 'main.py')], {
      cwd: agentDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    this.proc = proc

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.proc === proc) this.onData(chunk)
    })
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      console.error('[agent]', chunk.toString())
    })
    proc.stdin?.on('error', (err) => {
      console.error('[bridge] stdin error:', err.message)
    })
    proc.on('error', (err) => {
      console.error('[agent] process error:', err.message)
      if (proc.pid === undefined)
        this.handleDown(proc, { reason: 'spawn-error', error: err.message })
    })
    proc.on('exit', (code, signal) => {
      console.log('[agent] exited with code', code, signal ?? '')
      this.handleDown(proc, { reason: 'exit', code, signal })
    })

    // A v1 agent says nothing until pinged; a v2 agent opens with a ready event.
    // Ping right away and let whichever answers first decide the framing.
    try {
      await new Promise<void>((resolve, reject) => {
        this.onReady = resolve
        this.handshakePingId = this.idCounter + 1
        this.call('ping', {}).then(
          () => resolve(),
          (err) => {
            if (this.proto !== 2) reject(err)
          }
        )
      })
    } catch (err) {
      if (this.proc === proc) proc.kill()
      throw err
    } finally {
      this.onReady = null
      this.handshakePingId = null
    }

    if (this.proc !== proc) throw new AgentError('E_AGENT_EXIT', 'Agent exited during start')

    try {
      if (this.protocol === 2 && this.initArgs) {
        await this.call('init', { ...(await this.initArgs()) })
      } else if (this.initState) {
        await this.initState()
      }
    } catch (err) {
      console.error('[bridge] init state failed:', (err as Error).message)
    }
    if (this.proc === proc) this.emit('agent-ready', { protocol: this.protocol, ...this.agentInfo })
  }

  private handleDown(proc: ChildProcess, info: Record<string, unknown>): void {
    if (this.proc !== proc) return
    this.proc = null
    this.resetStream()
    this.rejectAll('E_AGENT_EXIT', 'Agent exited')

    if (this.stopping) return

    const { baseMs, maxMs, maxRestarts, windowMs } = this.restartPolicy
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs)
    if (this.restartTimes.length >= maxRestarts) {
      console.error('[agent] restart limit reached, giving up')
      this.emit('agent-down', { ...info, willRestart: false, gaveUp: true })
      return
    }

    const delay = Math.min(baseMs * 2 ** this.restartTimes.length, maxMs)
    this.restartTimes.push(now)
    this.emit('agent-down', { ...info, willRestart: true, restartInMs: delay })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.launch().catch((err) => {
        console.error('[agent] restart failed:', (err as Error).message)
      })
    }, delay)
  }

  private resetStream(): void {
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.scanFrom = 0
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let start = 0
    let nl = this.buffer.indexOf('\n', this.scanFrom)
    while (nl !== -1) {
      const line = this.buffer.slice(start, nl)
      start = nl + 1
      this.handleLine(line)
      nl = this.buffer.indexOf('\n', start)
    }
    this.buffer = this.buffer.slice(start)
    this.scanFrom = this.buffer.length
  }

  private handleLine(raw: string): void {
    const line = raw.trim()
    if (!line) return

    let msg: WireMessage
    try {
      msg = JSON.parse(line)
    } catch {
      console.log('[bridge] non-JSON from agent:', line)
      return
    }
    if (!isRecord(msg)) {
      console.log('[bridge] non-JSON from agent:', line)
      return
    }

    if (msg.v === 2 && msg.event === 'ready') {
      this.handleReady(msg.data)
      return
    }

    if (typeof msg.event === 'string') {
      const data = msg.v === 2 ? (isRecord(msg.data) ? msg.data : {}) : this.v1EventData(msg)
      if (!QUIET_EVENTS.has(msg.event)) console.log('[bridge] event:', msg.event)
      this.emit(msg.event, data)
      return
    }

    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)

    if (msg.v === 2) {
      if (msg.ok) {
        pending.resolve(msg.result)
        return
      }
      const err = isRecord(msg.error) ? msg.error : {}
      const code = typeof err.code === 'string' ? err.code : 'E_INTERNAL'
      const message = typeof err.message === 'string' ? err.message : `${pending.cmd} failed`
      console.error('[bridge] cmd error id=%d %s:', msg.id, code, message)
      pending.reject(new AgentError(code, message))
      return
    }

    if (msg.error) {
      console.error('[bridge] cmd error id=%d:', msg.id, msg.error)
      pending.reject(new AgentError('E_AGENT_CMD', String(msg.error)))
    } else {
      pending.resolve(msg.result)
    }
  }

  private v1EventData(msg: WireMessage): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...msg }
    delete rest.event
    return rest
  }

  private handleReady(data: unknown): void {
    this.proto = 2
    this.info = parseInfo(data)
    console.log('[bridge] agent v2 ready: %s %s', this.info.impl, this.info.version)
    // The handshake ping went out in v1 framing; drop it instead of waiting on a reply.
    const pingId = this.handshakePingId
    if (pingId !== null) {
      const p = this.pending.get(pingId)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(pingId)
      }
    }
    this.onReady?.()
  }

  private emit(event: string, data: Record<string, unknown>): void {
    for (const h of this.eventHandlers[event] ?? []) {
      try {
        h(data)
      } catch (err) {
        console.error('[bridge] handler error for %s:', event, err)
      }
    }
  }

  private rejectAll(code: AgentErrorCode, message: string): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const p of entries) {
      clearTimeout(p.timer)
      p.reject(new AgentError(code, `${message}: ${p.cmd}`))
    }
  }

  private call(
    cmd: string,
    params: Record<string, unknown>,
    opts: RequestOptions = {}
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin
      if (!this.proc || !stdin) {
        reject(new AgentError('E_AGENT_NOT_RUNNING', `Agent not running: ${cmd}`))
        return
      }
      if (!stdin.writable || stdin.destroyed) {
        reject(new AgentError('E_AGENT_EPIPE', `Agent stdin closed: ${cmd}`))
        return
      }
      const { signal } = opts
      if (signal?.aborted) {
        reject(new AgentError('E_CANCELLED', `Cancelled: ${cmd}`))
        return
      }

      const id = ++this.idCounter
      const proto = this.proto
      const settle = (): PendingCall | undefined => {
        const p = this.pending.get(id)
        if (!p) return undefined
        this.pending.delete(id)
        clearTimeout(p.timer)
        return p
      }
      const onAbort = (): void => {
        if (!settle()) return
        reject(new AgentError('E_CANCELLED', `Cancelled: ${cmd}`))
        if (proto === 2 && this.proto === 2) {
          this.call('cancel', { target: id }).catch((err) => {
            console.error('[bridge] cancel failed:', (err as Error).message)
          })
        }
      }
      const done = (): void => signal?.removeEventListener('abort', onAbort)
      const timer = setTimeout(
        () => {
          if (!settle()) return
          done()
          reject(new AgentError('E_AGENT_TIMEOUT', `Agent timeout: ${cmd}`))
        },
        opts.timeoutMs ?? timeoutFor(cmd, params)
      )
      this.pending.set(id, {
        cmd,
        resolve: (v) => {
          done()
          resolve(v)
        },
        reject: (e) => {
          done()
          reject(e)
        },
        timer
      })
      signal?.addEventListener('abort', onAbort, { once: true })

      const fail = (err: Error): void => {
        const p = settle()
        if (!p) return
        p.reject(new AgentError('E_AGENT_EPIPE', `Agent write failed (${err.message}): ${cmd}`))
      }
      const frame = proto === 2 ? { v: 2, id, cmd, args: params } : { id, cmd, ...params }
      try {
        stdin.write(JSON.stringify(frame) + '\n', (err) => {
          if (err) fail(err)
        })
      } catch (err) {
        fail(err as Error)
      }
    })
  }
}
