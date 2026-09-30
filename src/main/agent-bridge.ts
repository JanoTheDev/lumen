import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AgentAction } from './actions/agent-action'

export type AgentErrorCode =
  | 'E_AGENT_EXIT'
  | 'E_AGENT_STOPPED'
  | 'E_AGENT_NOT_RUNNING'
  | 'E_AGENT_EPIPE'
  | 'E_AGENT_TIMEOUT'
  | 'E_AGENT_CMD'

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

export interface RestartPolicy {
  baseMs: number
  maxMs: number
  maxRestarts: number
  windowMs: number
}

export interface AgentBridgeOptions {
  spawnFn?: SpawnFn
  // Runs after every successful (re)start ping; use it to re-send hotkey, listener and dwell state.
  initState?: () => Promise<void>
  restart?: Partial<RestartPolicy>
}

type EventHandler = (data?: Record<string, unknown>) => void

interface PendingCall {
  cmd: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 15000
const CMD_TIMEOUT_MS: Record<string, number> = {
  screenshot: 5000,
  wake_enable: 30000
}
const LONG_ACTION_TIMEOUT_MS = 60000
const LONG_ACTIONS = new Set(['type', 'scroll'])

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
  return CMD_TIMEOUT_MS[cmd] ?? DEFAULT_TIMEOUT_MS
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
  private restartPolicy: RestartPolicy

  constructor(opts: AgentBridgeOptions = {}) {
    this.spawnFn = opts.spawnFn ?? (spawn as SpawnFn)
    this.initState = opts.initState
    this.restartPolicy = { ...DEFAULT_RESTART, ...opts.restart }
  }

  setInitState(fn: () => Promise<void>): void {
    this.initState = fn
  }

  onEvent(event: string, cb: EventHandler): void {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = []
    this.eventHandlers[event].push(cb)
  }

  get running(): boolean {
    return this.proc !== null
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

  async screenshot(): Promise<string> {
    return this.call('screenshot', {}) as Promise<string>
  }

  async activeWindow(): Promise<string> {
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

  async setDwellMs(dwellMs: number): Promise<unknown> {
    return this.call('dwell_set_ms', { dwell_ms: dwellMs })
  }

  private async launch(): Promise<void> {
    const agentDir = is.dev ? join(app.getAppPath(), 'agent') : join(process.resourcesPath, 'agent')
    const venvPython =
      process.platform === 'win32'
        ? join(agentDir, '.venv', 'Scripts', 'python.exe')
        : join(agentDir, '.venv', 'bin', 'python3')

    this.resetStream()
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

    try {
      await this.call('ping', {})
    } catch (err) {
      if (this.proc === proc) proc.kill()
      throw err
    }

    if (this.initState) {
      try {
        await this.initState()
      } catch (err) {
        console.error('[bridge] init state failed:', (err as Error).message)
      }
    }
    if (this.proc === proc) this.emit('agent-ready', {})
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

    let msg: { id?: number; result?: unknown; error?: string; event?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      console.log('[bridge] non-JSON from agent:', line)
      return
    }
    if (!msg || typeof msg !== 'object') {
      console.log('[bridge] non-JSON from agent:', line)
      return
    }

    if (msg.event) {
      if (!QUIET_EVENTS.has(msg.event)) console.log('[bridge] event:', msg.event)
      this.emit(msg.event, msg as unknown as Record<string, unknown>)
      return
    }

    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) {
      console.error('[bridge] cmd error id=%d:', msg.id, msg.error)
      pending.reject(new AgentError('E_AGENT_CMD', msg.error))
    } else {
      pending.resolve(msg.result)
    }
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

  private call(cmd: string, params: Record<string, unknown>): Promise<unknown> {
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

      const id = ++this.idCounter
      const timer = setTimeout(
        () => {
          if (this.pending.delete(id))
            reject(new AgentError('E_AGENT_TIMEOUT', `Agent timeout: ${cmd}`))
        },
        timeoutFor(cmd, params)
      )
      this.pending.set(id, { cmd, resolve, reject, timer })

      const fail = (err: Error): void => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        reject(new AgentError('E_AGENT_EPIPE', `Agent write failed (${err.message}): ${cmd}`))
      }
      try {
        stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n', (err) => {
          if (err) fail(err)
        })
      } catch (err) {
        fail(err as Error)
      }
    })
  }
}
