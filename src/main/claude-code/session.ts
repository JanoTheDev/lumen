// One Claude Code session: a long-lived `claude -p --input-format stream-json` process in the
// project folder. User turns are JSON lines on stdin, events come back as NDJSON. Interrupt is a
// stdin control_request (probe 2026-10-01); when the CLI does not answer in time the process is
// killed and the next turn resumes it with --resume <session_id>.
import { EventEmitter } from 'events'
import type { AutopilotLevel, ClaudeSessionView } from '@shared/claude-code'
import { buildArgs, command, type ClaudeArgsInput, type SpawnCommand } from './cli'
import { readEvent } from './events'
import { NdjsonParser } from './ndjson'

export const INTERRUPT_WAIT_MS = 3000
const STOP_GRACE_MS = 3000
const STDERR_KEEP = 2000

/** The parts of a ChildProcess the session uses (a fake in tests). */
export interface ChildLike {
  stdin: {
    write(s: string): boolean
    end(): void
    destroyed?: boolean
    on?(event: 'error', fn: (err: Error) => void): unknown
  } | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  /** Ends the process with everything it started (kill-tree.ts); `sync` on app quit. */
  killTree?(sync: boolean): void
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export interface SessionDeps {
  spawn(cmd: SpawnCommand, cwd: string, env: NodeJS.ProcessEnv): ChildLike
  now(): number
  log?(msg: string): void
}

export interface SessionInit {
  id: string
  project: string
  projectName: string
  cliPath: string
  autopilot: AutopilotLevel
  /** Flags for every (re)spawn; `resume` comes from the session id. */
  args: Omit<ClaudeArgsInput, 'resume'>
  /** Flags worked out again at every spawn (the coding-skills plugin folder). */
  spawnArgs?: () => Partial<Omit<ClaudeArgsInput, 'resume'>>
  env?: NodeJS.ProcessEnv
  /** Resume this CLI session id instead of starting a new one. */
  resume?: string
  title?: string
}

/** `interrupted`: the turn Lumen stopped (no done / problem notice for it). */
export type TurnEnd = { text: string; isError: boolean; interrupted: boolean }

export function userLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}

/**
 * Read-only taps on every session (the task chat transcript, 08 T41): 'user' (id, text) for
 * each user turn written, 'event' (id, event) for each stream-json event read.
 */
export const sessionTaps = new EventEmitter()

export class ClaudeSession extends EventEmitter {
  view: ClaudeSessionView
  private child: ChildLike | null = null
  /** Cost of earlier processes of this session (result.total_cost_usd is per process). */
  private costBase = 0
  private procCost = 0
  private controls = new Map<string, (ok: boolean) => void>()
  private controlSeq = 0
  private stopping = false
  private interrupting = false
  /** User turns written and not ended by a `result` yet. */
  private inFlight = 0
  private stderrTail = ''
  /** Restart the process once the current turn ends (coding skills changed). */
  private recyclePending = false
  /** The process was ended by recycle(): the session counts as running and resumes on send. */
  private retired = false

  constructor(
    private readonly init: SessionInit,
    private readonly deps: SessionDeps
  ) {
    super()
    const now = deps.now()
    this.view = {
      id: init.id,
      project: init.project,
      projectName: init.projectName,
      ...(init.resume ? { sessionId: init.resume } : {}),
      title: init.title ?? init.projectName,
      phase: 'stopped',
      lastLine: '',
      costUsd: 0,
      turns: 0,
      startedAt: now,
      lastActive: now,
      autopilot: init.autopilot,
      autoAnswers: [],
      commands: []
    }
  }

  get alive(): boolean {
    return !!this.child || this.retired
  }

  /** Patches the view and tells listeners (manager, UI). */
  update(patch: Partial<ClaudeSessionView>): void {
    this.view = { ...this.view, ...patch }
    this.emit('change', this.view)
  }

  /** Sends a user turn, starting (or resuming) the process when it is not running. */
  send(text: string): void {
    if (!this.child) this.spawn()
    this.write(userLine(text))
    sessionTaps.emit('user', this.view.id, text)
    this.inFlight++
    this.update({
      phase: 'thinking',
      pending: undefined,
      lastActive: this.deps.now(),
      lastLine: 'Thinking'
    })
  }

  /** Stops the current turn. true = the CLI confirmed; false = the process had to be killed. */
  async interrupt(): Promise<boolean> {
    // Nothing running: an acknowledged interrupt would leave no result to match.
    if (!this.child || this.inFlight === 0) return true
    const id = `lumen-int-${++this.controlSeq}`
    this.interrupting = true
    const answered = new Promise<boolean>((resolve) => {
      this.controls.set(id, resolve)
      setTimeout(() => {
        if (this.controls.delete(id)) resolve(false)
      }, INTERRUPT_WAIT_MS)
    })
    this.write(
      `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })}\n`
    )
    const ok = await answered
    if (ok) {
      this.update({ phase: 'idle', pending: undefined, lastLine: 'Interrupted' })
      return true
    }
    this.deps.log?.(`[${this.view.id}] interrupt not answered, killing the process`)
    this.kill()
    return false
  }

  /** Throws when the command line cannot be built (before the session is listed anywhere). */
  checkCommand(): void {
    command(this.init.cliPath, buildArgs({ ...this.init.args, resume: this.view.sessionId }))
  }

  /**
   * The next turn starts a fresh process (same CLI session, --resume) so it loads changed
   * startup inputs such as the coding-skills plugin folder. A busy session finishes its turn
   * first. Returns true when the restart is done or queued.
   */
  recycle(): boolean {
    if (!this.child) return true
    if (this.inFlight > 0 || this.interrupting || !this.view.sessionId) {
      this.recyclePending = true
      return true
    }
    this.retire()
    return true
  }

  /** Ends the idle process quietly; the session stays as it is and resumes on the next turn. */
  private retire(): void {
    const child = this.child
    this.recyclePending = false
    if (!child) return
    this.child = null
    this.retired = true
    let exited = false
    child.on('exit', () => (exited = true))
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (exited) return
      try {
        if (child.killTree) child.killTree(false)
        else child.kill()
      } catch {
        /* gone */
      }
    }, STOP_GRACE_MS).unref?.()
    this.deps.log?.(`[${this.view.id}] restarting on the next turn to load new skills`)
  }

  /**
   * App quit: stdin closed, and a process in the middle of a turn is killed now (with its
   * children); a timer would never fire once the app has exited.
   */
  shutdown(): void {
    const child = this.child
    if (!child) return
    const busy = this.inFlight > 0 || this.interrupting
    this.stopping = true
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    if (busy) this.kill(true)
  }

  /** Ends the process (stdin closed, killed after a grace period). Resumable later. */
  stop(): void {
    this.retired = false
    if (!this.child) {
      this.update({ phase: 'stopped', pending: undefined })
      return
    }
    this.stopping = true
    const child = this.child
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (this.child === child) this.kill()
    }, STOP_GRACE_MS).unref?.()
    this.update({ phase: 'stopped', pending: undefined })
  }

  // ---- internals ----

  private kill(sync = false): void {
    const child = this.child
    if (!child) return
    this.stopping = true
    try {
      if (child.killTree) child.killTree(sync)
      else child.kill()
    } catch {
      /* gone */
    }
  }

  private write(line: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) throw new Error('Claude Code is not running')
    stdin.write(line)
  }

  private spawn(): void {
    const args = buildArgs({
      ...this.init.args,
      ...this.init.spawnArgs?.(),
      resume: this.view.sessionId
    })
    const cmd = command(this.init.cliPath, args)
    this.costBase += this.procCost
    this.procCost = 0
    this.stopping = false
    this.interrupting = false
    this.inFlight = 0
    this.stderrTail = ''
    this.recyclePending = false
    this.retired = false
    const child = this.deps.spawn(cmd, this.init.project, { ...process.env, ...this.init.env })
    this.child = child
    this.update({ phase: 'starting', error: undefined, lastLine: 'Starting Claude Code' })
    const parser = new NdjsonParser(
      (ev) => {
        // A retired process (recycle) may still flush a line; it belongs to no turn now.
        if (this.child === child) this.onEvent(ev)
      },
      (junk) => this.deps.log?.(`[${this.view.id}] non-json: ${junk}`)
    )
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (d: string | Buffer) => parser.push(String(d)))
    child.stdout?.on('end', () => parser.end())
    child.stderr?.on('data', (d: string | Buffer) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-STDERR_KEEP)
    })
    // EPIPE when the CLI exits while a turn is being written: the turn ends as an error.
    child.stdin?.on?.('error', (err) => {
      this.deps.log?.(`[${this.view.id}] stdin: ${err.message}`)
      if (this.child !== child || this.stopping) return
      const lost = this.inFlight > 0
      this.inFlight = 0
      this.update({
        phase: 'failed',
        pending: undefined,
        error: err.message,
        lastLine: 'Claude Code stopped reading'
      })
      if (lost) this.emit('turn', { text: '', isError: true, interrupted: false } satisfies TurnEnd)
    })
    child.on('error', (err) => {
      if (this.child !== child) return
      this.child = null
      this.update({ phase: 'failed', error: err.message, lastLine: 'Could not start Claude Code' })
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      for (const [, resolve] of this.controls) resolve(false)
      this.controls.clear()
      const expected = this.stopping || code === 0
      const error = expected ? undefined : this.stderrTail.trim().split('\n').pop()?.slice(0, 300)
      this.update({
        phase: expected ? (this.view.phase === 'failed' ? 'failed' : 'stopped') : 'failed',
        pending: undefined,
        ...(error ? { error, lastLine: `Claude Code stopped: ${error}` } : {})
      })
      this.emit('exit', code)
    })
  }

  private onEvent(ev: Record<string, unknown>): void {
    sessionTaps.emit('event', this.view.id, ev)
    const fx = readEvent(ev)
    if (fx.controlResponse) {
      const r = this.controls.get(fx.controlResponse.requestId)
      if (r) {
        this.controls.delete(fx.controlResponse.requestId)
        r(fx.controlResponse.ok)
      }
    }
    const patch = { ...fx.patch }
    // A permission or question shown to the user keeps its phase until it is answered.
    if (this.view.pending && patch.phase && !fx.turnEnded) delete patch.phase
    const interrupted = !!fx.turnEnded && this.interrupting
    if (fx.turnEnded) {
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.interrupting = false
      if (interrupted) patch.lastLine = 'Interrupted'
      if (fx.turnEnded.costUsd !== undefined) this.procCost = fx.turnEnded.costUsd
      patch.costUsd = this.costBase + this.procCost
      patch.turns = this.view.turns + 1
      patch.lastActive = this.deps.now()
    }
    if (Object.keys(patch).length) this.update(patch)
    if (fx.turnEnded) {
      const end: TurnEnd = { text: fx.turnEnded.text, isError: fx.turnEnded.isError, interrupted }
      if (this.recyclePending && this.inFlight === 0 && this.view.sessionId) this.retire()
      this.emit('turn', end)
    }
  }
}
