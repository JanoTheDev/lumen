import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { existsSync } from 'fs'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AgentAction } from '../actions/agent-action'
import type { AgentInitArgs } from './state'
import { missingCapabilities, nativeCandidates, nativeLaunch, type AgentPathEnv } from './impl'

export type AgentErrorCode =
  | 'E_AGENT_EXIT'
  | 'E_AGENT_STOPPED'
  | 'E_AGENT_NOT_RUNNING'
  | 'E_AGENT_MISSING'
  | 'E_AGENT_EPIPE'
  | 'E_AGENT_TIMEOUT'
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
  // State sent as the `init` command after every ready handshake (start and restarts).
  initArgs?: () => AgentInitArgs | Promise<AgentInitArgs>
  restart?: Partial<RestartPolicy>
  // How long a fresh agent may take to send its `ready` event.
  readyTimeoutMs?: number
  // Overrides for path resolution (tests).
  paths?: Partial<AgentPathEnv>
}

export interface RequestOptions {
  timeoutMs?: number
  // Aborting rejects with E_CANCELLED and sends `cancel` for the in-flight id.
  signal?: AbortSignal
}

type EventHandler = (data?: Record<string, unknown>) => void

interface PendingCall {
  cmd: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Handshake {
  resolve: () => void
  reject: (e: Error) => void
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
const READY_TIMEOUT_MS = 15000
const CMD_TIMEOUT_MS: Record<string, number> = {
  capture: 10000,
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

function describeDown(info: Record<string, unknown>): string {
  if (info.reason === 'spawn-error') return `agent could not start (${String(info.error)})`
  if (info.reason === 'start-failed') return String(info.error)
  const how = info.signal ? `signal ${String(info.signal)}` : `code ${String(info.code)}`
  return `agent exited (${how})`
}

/** Runs the native agent (`lumen-native --protocol 2`) and speaks NDJSON protocol v2 to it. */
export class AgentBridge {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingCall>()
  private idCounter = 0
  private decoder = new StringDecoder('utf8')
  /** Pieces of the line still waiting for its newline; joined once it arrives. */
  private partial: string[] = []
  private eventHandlers: Record<string, EventHandler[]> = {}
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimes: number[] = []
  private spawnFn: SpawnFn
  private initArgs?: () => AgentInitArgs | Promise<AgentInitArgs>
  private restartPolicy: RestartPolicy
  private readyTimeoutMs: number
  private info: AgentInfo | null = null
  private handshake: Handshake | null = null
  // Bumped by every launch and stop: a launch whose generation is no longer current is stale.
  private generation = 0
  private failure: string | null = null
  private paths: Partial<AgentPathEnv>

  constructor(opts: AgentBridgeOptions = {}) {
    this.spawnFn = opts.spawnFn ?? (spawn as SpawnFn)
    this.initArgs = opts.initArgs
    this.restartPolicy = { ...DEFAULT_RESTART, ...opts.restart }
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.paths = opts.paths ?? {}
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

  /** Why the agent is not running (missing exe, failed handshake, exit), or null. */
  get lastError(): string | null {
    return this.proc ? null : this.failure
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
    this.restartTimes = []
    this.clearRestartTimer()
    await this.launch()
  }

  stop(): void {
    this.stopping = true
    this.generation++
    this.clearRestartTimer()
    const proc = this.proc
    this.proc = null
    this.resetStream()
    this.failHandshake(new AgentError('E_AGENT_STOPPED', 'Agent stopped'))
    this.rejectAll('E_AGENT_STOPPED', 'Agent stopped')
    proc?.kill()
  }

  /** Sends a command and resolves with its result. */
  request<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: RequestOptions = {}
  ): Promise<T> {
    return this.call(cmd, args, opts) as Promise<T>
  }

  /** Asks the agent to abort the in-flight command `targetId`. */
  async cancel(targetId: number): Promise<void> {
    await this.call('cancel', { target: targetId })
  }

  /** Title of the foreground window. */
  async activeWindow(): Promise<string> {
    const res = (await this.call('active_window', {})) as { title?: unknown } | null
    return typeof res?.title === 'string' ? res.title : 'Unknown'
  }

  async execute(action: AgentAction): Promise<unknown> {
    if (action.type === 'open_url') return
    return this.call('execute', { action })
  }

  async setHotkey(combo: string): Promise<unknown> {
    return this.call('set_hotkey', { combo })
  }

  /** Second push-to-talk binding: emits dictation-down / dictation-up. "" unbinds. */
  async setDictationHotkey(combo: string): Promise<unknown> {
    return this.call('set_dictation_hotkey', { combo })
  }

  private env(): AgentPathEnv {
    return {
      dev: is.dev,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      exists: existsSync,
      ...this.paths
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private failHandshake(err: Error): void {
    const hs = this.handshake
    this.handshake = null
    hs?.reject(err)
  }

  private async launch(): Promise<void> {
    const gen = ++this.generation
    const stale = (): boolean => gen !== this.generation || this.stopping
    // start() while a child runs replaces it; its exit is then ignored by handleDown.
    const old = this.proc
    this.proc = null
    this.failHandshake(new AgentError('E_AGENT_STOPPED', 'Agent replaced'))
    this.rejectAll('E_AGENT_EXIT', 'Agent replaced')
    old?.kill()
    this.resetStream()
    this.info = null

    const env = this.env()
    const spec = nativeLaunch(env)
    if (!spec) {
      this.failure = `native agent not found (${nativeCandidates(env)[0]})`
      console.error('[agent] %s', this.failure)
      throw new AgentError('E_AGENT_MISSING', this.failure)
    }

    const proc = this.spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
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

    // The agent opens with a `ready` event carrying impl, version and capabilities.
    let hs!: Handshake
    const ready = new Promise<void>((resolve, reject) => {
      hs = { resolve, reject }
    })
    this.handshake = hs
    const timer = setTimeout(
      () => hs.reject(new AgentError('E_AGENT_TIMEOUT', 'Agent sent no ready event')),
      this.readyTimeoutMs
    )
    try {
      await ready
    } catch (err) {
      if (!stale()) {
        this.failure = `agent failed to start: ${(err as Error).message}`
        // Killing it goes through handleDown, which schedules the next try with backoff.
        if (this.proc === proc) proc.kill()
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (this.handshake === hs) this.handshake = null
    }

    const missing = missingCapabilities(this.capabilities)
    if (missing.length) console.error('[agent] native agent lacks %s', missing.join(', '))

    try {
      const args = this.initArgs ? await this.initArgs() : null
      if (args && !stale() && this.proc === proc) await this.call('init', { ...args })
    } catch (err) {
      console.error('[bridge] init failed:', (err as Error).message)
    }
    if (stale() || this.proc !== proc) {
      throw new AgentError('E_AGENT_EXIT', 'Agent exited during start')
    }
    this.failure = null
    this.emit('agent-ready', { ...this.agentInfo })
  }

  private handleDown(proc: ChildProcess, info: Record<string, unknown>): void {
    if (this.proc !== proc) return
    this.proc = null
    this.resetStream()
    this.failure = describeDown(info)
    this.failHandshake(new AgentError('E_AGENT_EXIT', this.failure))
    this.rejectAll('E_AGENT_EXIT', 'Agent exited')
    if (this.stopping) return
    this.scheduleRestart(info)
  }

  private scheduleRestart(info: Record<string, unknown>): void {
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
        // No child whose exit would retry (exe missing): keep trying on the same backoff.
        if (!this.proc && !this.restartTimer && !this.stopping) {
          this.scheduleRestart({ reason: 'start-failed', error: (err as Error).message })
        }
      })
    }, delay)
  }

  private resetStream(): void {
    this.decoder = new StringDecoder('utf8')
    this.partial = []
  }

  // Only the new chunk is scanned, and a long line is kept as pieces until its newline:
  // appending to one growing string made V8 flatten it on every chunk (quadratic).
  private onData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let start = 0
    let nl = text.indexOf('\n')
    while (nl !== -1) {
      let line = text.slice(start, nl)
      if (this.partial.length) {
        this.partial.push(line)
        line = this.partial.join('')
        this.partial = []
      }
      start = nl + 1
      this.handleLine(line)
      nl = text.indexOf('\n', start)
    }
    if (start < text.length) this.partial.push(text.slice(start))
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
    if (!isRecord(msg) || msg.v !== 2) {
      console.log('[bridge] not a v2 frame from agent:', line)
      return
    }

    if (msg.event === 'ready') {
      this.handleReady(msg.data)
      return
    }

    if (typeof msg.event === 'string') {
      if (!QUIET_EVENTS.has(msg.event)) console.log('[bridge] event:', msg.event)
      this.emit(msg.event, isRecord(msg.data) ? msg.data : {})
      return
    }

    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)

    if (msg.ok) {
      pending.resolve(msg.result)
      return
    }
    const err = isRecord(msg.error) ? msg.error : {}
    const code = typeof err.code === 'string' ? err.code : 'E_INTERNAL'
    const message = typeof err.message === 'string' ? err.message : `${pending.cmd} failed`
    console.error('[bridge] cmd error id=%d %s:', msg.id, code, message)
    pending.reject(new AgentError(code, message))
  }

  private handleReady(data: unknown): void {
    this.info = parseInfo(data)
    console.log('[bridge] agent ready: %s %s', this.info.impl, this.info.version)
    this.handshake?.resolve()
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
      const proc = this.proc
      const stdin = proc?.stdin
      if (!proc || !stdin) {
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
        // Only the agent that got the command can cancel it.
        if (this.proc !== proc) return
        this.call('cancel', { target: id }).catch((err) => {
          console.error('[bridge] cancel failed:', (err as Error).message)
        })
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
      try {
        stdin.write(JSON.stringify({ v: 2, id, cmd, args: params }) + '\n', (err) => {
          if (err) fail(err)
        })
      } catch (err) {
        fail(err as Error)
      }
    })
  }
}
