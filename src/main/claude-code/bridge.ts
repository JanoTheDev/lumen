// Permission bridge (08 T35): a PermissionRequest hook from a Lumen-started session goes through
// the autopilot policy → approved, or asked on the bar's confirm card / by voice ("approve",
// "deny", "always allow this"), or denied. Every decision lands in the audit log (origin
// claude-code). Electron-free: the card, presence and audit are injected.
import type { AutopilotLevel } from '@shared/claude-code'
import type { AuditDecision, AuditEntry } from '../audit/log'
import { redactForLog } from '../actions/redact'
import { decidePermission, type ClaudeDecision } from './policy'

export type PermAnswer = 'once' | 'always' | 'deny'

export interface PendingPermission {
  id: string
  sessionKey: string
  projectName: string
  tool: string
  what: string
  reason: string
  risk: ClaudeDecision['risk']
  hard: boolean
  createdAt: number
}

export interface BridgeSession {
  project: string
  projectName: string
  level: AutopilotLevel
}

export interface BridgeDeps {
  session(key: string): BridgeSession | null
  /** Shows the confirm card; resolves with the user's answer (false = no). */
  ask(p: PendingPermission): Promise<boolean>
  /** Takes the card down after a voice answer or a hang-up. */
  dismiss(p: PendingPermission): void
  /** Someone is at the PC to answer. */
  present(): boolean
  onPending(key: string, p: PendingPermission | null): void
  audit(entry: AuditEntry): void
  now(): number
}

type Json = Record<string, unknown>

function out(behavior: 'allow' | 'deny', extra: Json = {}): Json {
  return {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...extra } }
  }
}

const NOT_HERE = 'The user is away; Lumen does not approve this on its own. Ask again later.'
const SAID_NO = 'The user said no (via Lumen).'
/** Hook key of a session started by hand (the global hooks observer, T38). */
export const OBSERVED_PREFIX = 'g:'

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export class PermissionBridge {
  private open = new Map<string, { p: PendingPermission; resolve: (a: PermAnswer) => void }>()
  private seq = 0

  constructor(private readonly deps: BridgeDeps) {}

  list(): PendingPermission[] {
    return [...this.open.values()].map((o) => o.p)
  }

  /** Voice / Settings answer: a given id, else the oldest waiting permission. */
  answer(answer: PermAnswer, id?: string): boolean {
    const o = id ? this.open.get(id) : this.open.values().next().value
    if (!o) return false
    this.deps.dismiss(o.p)
    o.resolve(answer)
    return true
  }

  async handle(key: string, payload: Json, signal: AbortSignal): Promise<Json> {
    const s = this.deps.session(key)
    if (!s) return {}
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'a tool'
    const input = (payload.tool_input as Json | undefined) ?? {}
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : s.project
    const d = decidePermission({ tool, input, cwd, project: s.project }, s.level)
    const t0 = this.deps.now()
    const audit = this.auditor(key, tool, d, t0)

    if (d.verdict === 'allow') {
      audit('auto', true)
      return out('allow')
    }
    if (d.hard && !this.deps.present()) {
      audit('blocked', false)
      return out('deny', { message: NOT_HERE })
    }

    const p = this.pending(key, s.projectName, tool, d, t0)
    const answer = await this.wait(p, signal)
    return this.reply(p, answer === 'timeout' ? 'deny' : answer, payload, audit)
  }

  /**
   * PermissionRequest from a session the user started by hand (opt-in global hook, T38): no
   * autopilot, the user answers on the bar or by voice. Nobody at the PC, or no answer within
   * `waitMs`: `{}`, so Claude shows its own prompt in the terminal.
   */
  async handleObserved(payload: Json, signal: AbortSignal, waitMs: number): Promise<Json> {
    if (!this.deps.present()) return {}
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'a tool'
    const input = (payload.tool_input as Json | undefined) ?? {}
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
    const sid = typeof payload.session_id === 'string' ? payload.session_id.slice(0, 80) : '?'
    const base = decidePermission({ tool, input, cwd, project: cwd }, 'off')
    const d: ClaudeDecision = base.hard ? base : { ...base, reason: 'a session you started' }
    const t0 = this.deps.now()
    const key = `${OBSERVED_PREFIX}${sid}`
    const audit = this.auditor(key, tool, d, t0)
    const p = this.pending(key, baseName(cwd) || 'a project', tool, d, t0)
    const answer = await this.wait(p, signal, waitMs)
    if (answer === 'timeout') return {}
    return this.reply(p, answer, payload, audit)
  }

  private auditor(
    key: string,
    tool: string,
    d: ClaudeDecision,
    t0: number
  ): (decision: AuditDecision, ok: boolean) => void {
    return (decision, ok) =>
      this.deps.audit({
        t: new Date(t0).toISOString(),
        task: `claude-code:${key}`,
        origin: 'claude-code',
        action: { type: 'claude_tool', tool, what: redactForLog(d.what).slice(0, 300) },
        risk: d.risk,
        decision,
        result: ok ? 'ok' : 'denied',
        ms: this.deps.now() - t0,
        reason: d.reason
      })
  }

  private pending(
    key: string,
    projectName: string,
    tool: string,
    d: ClaudeDecision,
    t0: number
  ): PendingPermission {
    return {
      id: `perm_${++this.seq}`,
      sessionKey: key,
      projectName,
      tool,
      what: d.what,
      reason: d.reason,
      risk: d.risk,
      hard: !!d.hard,
      createdAt: t0
    }
  }

  /** Shows the card and waits for an answer, a hang-up (deny) or `waitMs` ('timeout'). */
  private wait(
    p: PendingPermission,
    signal: AbortSignal,
    waitMs = 0
  ): Promise<PermAnswer | 'timeout'> {
    return new Promise<PermAnswer | 'timeout'>((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (a: PermAnswer | 'timeout'): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        this.open.delete(p.id)
        signal.removeEventListener('abort', onAbort)
        this.deps.onPending(p.sessionKey, null)
        resolve(a)
      }
      const onAbort = (): void => {
        this.deps.dismiss(p)
        finish('deny')
      }
      this.open.set(p.id, { p, resolve: finish })
      this.deps.onPending(p.sessionKey, p)
      signal.addEventListener('abort', onAbort, { once: true })
      if (waitMs > 0)
        timer = setTimeout(() => {
          this.deps.dismiss(p)
          finish('timeout')
        }, waitMs)
      this.deps.ask(p).then(
        (ok) => finish(ok ? 'once' : 'deny'),
        () => finish('deny')
      )
    })
  }

  private reply(
    p: PendingPermission,
    answer: PermAnswer,
    payload: Json,
    audit: (decision: AuditDecision, ok: boolean) => void
  ): Json {
    // The hard list never gets "always".
    const final: PermAnswer = answer === 'always' && p.hard ? 'once' : answer
    if (final === 'deny') {
      audit('denied-by-user', false)
      return out('deny', { message: SAID_NO })
    }
    audit(final === 'always' ? 'always-by-user' : 'confirmed-by-user', true)
    const suggestions = Array.isArray(payload.permission_suggestions)
      ? payload.permission_suggestions
      : []
    // "Always": the CLI's own suggested session rules (e.g. allow this command for the session).
    return out(
      'allow',
      final === 'always' && suggestions.length ? { updatedPermissions: suggestions } : {}
    )
  }
}

/** The confirm card text for a permission. */
export function permissionSummary(p: PendingPermission): string {
  const head = `Claude in ${p.projectName} wants to ${p.tool === 'Bash' || p.tool === 'PowerShell' ? 'run' : 'use'}: ${p.what.slice(0, 300)}`
  const why = p.hard ? ` This always needs you: ${p.reason}.` : ` (${p.reason})`
  const always = p.hard ? '' : ' Say “always allow this” to allow it for this session.'
  return `${head}.${why}${always}`
}
