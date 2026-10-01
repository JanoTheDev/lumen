// The policy gate every action path runs before touching the machine (safety-policy.md):
// evaluate → blocked never runs, needsConfirm asks on the assistant bar (or counts as the
// user's own batch confirm) → exactly one audit line per action, written here on a deny and
// by finish() once the action ran.
import type { InputStep } from '@shared/types'
import {
  evaluate,
  maskedForConfirm,
  noteExecuted,
  type ConfirmMode,
  type Decision,
  type EvalAction,
  type Origin,
  type PolicyCtx,
  type TaskState,
  type WindowInfo
} from './safety'
import { describeActions } from '../a11y/captions'
import { withCheckoutPrice } from './checkout-price'
import { redactForLog } from './redact'
import { getAgent } from '../agent/instance'
import type { ActiveWindowInfo, FocusInfoResult } from '../agent/commands'
import { askUser } from '../agent-mode/confirm'
import { grants } from '../agent-mode/grants'
import {
  summarizeAction,
  summarizeArgs,
  writeAudit,
  type AuditDecision,
  type AuditResult
} from '../audit/log'
import { loadConfig } from '../config'
import { log } from '../logger'
import { setStatus } from '../windows/status'

export interface GateCtx {
  origin: Origin
  taskId: string
  /** The user's words for this task (dictated combos, local hosts, injection check). */
  userText?: string
  observedText?: string
  task?: TaskState
  /** The user already said yes to this batch (transcript confirm, explain-before-do). */
  approved?: boolean
  confirmMode?: ConfirmMode
  /**
   * A background task or routine (nobody may be watching): a confirm is not shown while the
   * user is away (a no, nothing spoken), and counts as a no after `timeoutMs`.
   */
  unattended?: { timeoutMs: number; present(): boolean }
}

export interface Gate {
  ok: boolean
  decision: Decision
  /** Writes the action's audit line (call once, only when ok). */
  finish(result: AuditResult): void
}

const ACTIVE_WINDOW_MS = 1500

function needsWindow(a: EvalAction, ctx: GateCtx): boolean {
  if (needsFocus(a)) return true
  const agentish = ctx.origin === 'agent' || ctx.origin === 'routine' || ctx.origin === 'mcp'
  return agentish && !!ctx.task && /^(click|uia_act)/.test(a.type)
}

/** Keyboard actions: the focused element decides (password field, IDE terminal). */
function needsFocus(a: EvalAction): boolean {
  if (a.type === 'type' || a.type === 'hotkey') return true
  if (a.type === 'uia_act' && a.action === 'set_value') return true
  return a.type === 'input' && !!a.steps?.some((s) => s.t === 'type' || s.t === 'keys')
}

/**
 * Title + process of the foreground window; {} when the agent cannot say. With `focus`, also
 * the focused element (password field, name, class) from focus_info; `focusKnown: false` when
 * the agent could not read it.
 */
export async function foregroundWindow(opts: { focus?: boolean } = {}): Promise<WindowInfo> {
  const unknown: WindowInfo = opts.focus ? { focusKnown: false } : {}
  const agent = getAgent()
  if (!agent) return unknown
  if (opts.focus) {
    try {
      const f = await agent.request<FocusInfoResult>(
        'focus_info',
        {},
        { timeoutMs: ACTIVE_WINDOW_MS }
      )
      if (f?.title || f?.process) return focusWindow(f)
    } catch {
      /* older agent: window only */
    }
  }
  try {
    const w = await agent.request<ActiveWindowInfo>(
      'active_window',
      {},
      { timeoutMs: ACTIVE_WINDOW_MS }
    )
    if (w?.title || w?.process)
      return {
        ...unknown,
        title: w.title,
        process: w.process,
        ...(w.className ? { windowClass: w.className } : {})
      }
  } catch {
    /* older agent: title only */
  }
  try {
    return { ...unknown, title: await agent.activeWindow() }
  } catch {
    return unknown
  }
}

function focusWindow(f: FocusInfoResult): WindowInfo {
  const known = f.uia === true
  return {
    title: f.title,
    process: f.process,
    focusKnown: known,
    ...(known
      ? { isPassword: f.password === true, focusName: f.name ?? '', focusRole: f.role ?? '' }
      : {}),
    ...(f.className ? { className: f.className } : {}),
    ...(f.windowClass ? { windowClass: f.windowClass } : {})
  }
}

/** One line for the confirm card, secrets masked. */
export function describeForConfirm(a: EvalAction): string {
  if (a.type === 'input' && a.steps) return describeSteps(a.steps)
  // A connector call: what it is called with, so the user does not approve it blind.
  if (a.type === 'mcp_tool') {
    const what = a.description ?? `${a.server ?? '?'}: ${a.tool ?? '?'}`
    const args = a.args && Object.keys(a.args).length ? summarizeArgs(a.args) : ''
    return args ? `${what} (${args})` : what
  }
  return describeActions([maskedForConfirm(a)])
}

function describeSteps(steps: InputStep[]): string {
  return describeActions(
    steps
      .filter((s) => s.t !== 'wait')
      .map((s) =>
        s.t === 'type'
          ? maskedForConfirm({ type: 'type', text: s.text })
          : s.t === 'keys'
            ? { type: 'hotkey', keys: s.combo }
            : { type: s.t }
      )
  )
}

/** Rates, confirms when needed, and audits a denial. `prevType`: the batch's previous action. */
export async function gate(action: EvalAction, ctx: GateCtx, prevType?: string): Promise<Gate> {
  const t0 = Date.now()
  const activeWindow = needsWindow(action, ctx)
    ? await foregroundWindow({ focus: needsFocus(action) })
    : undefined
  const agentish = ctx.origin === 'agent' || ctx.origin === 'routine' || ctx.origin === 'mcp'
  const cfg = loadConfig()
  const policyCtx: PolicyCtx = {
    origin: ctx.origin,
    activeWindow,
    grants: grants(),
    taskId: ctx.taskId,
    userText: ctx.userText,
    observedText: ctx.observedText,
    task: ctx.task,
    prevType,
    confirmMode: ctx.confirmMode ?? (agentish ? cfg.agent.confirm : undefined),
    allowSendWithoutReview: cfg.agent.allowSendWithoutReview
  }
  // A book / pay / order click: the card shows the price on the page now (05 T41).
  const decision = await withCheckoutPrice(evaluate(action, policyCtx))
  const audit = (verdict: AuditDecision, result: AuditResult): void =>
    writeAudit({
      t: new Date().toISOString(),
      task: ctx.taskId,
      origin: ctx.origin,
      action: summarizeAction(action, activeWindow?.process),
      risk: decision.risk,
      decision: verdict,
      result,
      ms: Date.now() - t0,
      ...(result === 'denied' ? { reason: auditReason(decision.reason, action) } : {})
    })

  let verdict: AuditDecision
  if (decision.risk === 'blocked') {
    log('fail', `blocked by policy: ${decision.reason}`)
    setStatus('error', `Blocked for safety: ${decision.reason}`, undefined, 3000)
    audit('blocked', 'denied')
    return { ok: false, decision, finish: () => {} }
  }
  if (!decision.needsConfirm) {
    verdict = decision.risk === 'medium' && decision.grantScope ? grantedOrAuto(decision) : 'auto'
  } else if (ctx.approved) {
    verdict = 'preapproved'
  } else if (ctx.unattended && !ctx.unattended.present()) {
    log('skip', `not confirmed (${decision.risk}), nobody at the PC: ${decision.reason}`)
    audit('denied-by-user', 'denied')
    return {
      ok: false,
      decision: { ...decision, reason: `${decision.reason} (nobody was there to confirm)` },
      finish: () => {}
    }
  } else {
    const answer = await askUser(
      describeForConfirm(action),
      decision,
      cfg.agent.cancelWindowMs,
      ctx.unattended?.timeoutMs,
      ctx.taskId
    )
    if (answer === 'deny') {
      log('skip', `not confirmed (${decision.risk}): ${decision.reason}`)
      audit('denied-by-user', 'denied')
      return { ok: false, decision, finish: () => {} }
    }
    verdict = answer === 'always' ? 'always-by-user' : 'confirmed-by-user'
  }
  let finished = false
  return {
    ok: true,
    decision,
    finish: (result) => {
      if (finished) return
      finished = true
      audit(verdict, result)
      if (result === 'ok') noteExecuted(action, policyCtx)
    }
  }
}

const TYPING = new Set(['type', 'input', 'uia_act'])

/**
 * A denial reason as the audit log keeps it: secrets (also in URLs) redacted, and for typing
 * the quoted text (a terminal command) replaced by its length. The card still shows it.
 */
export function auditReason(reason: string, a: EvalAction): string {
  const r = TYPING.has(a.type)
    ? reason.replace(/“[^”]*”/g, (m) => `(${m.length - 2} chars)`)
    : reason
  return redactForLog(r)
}

function grantedOrAuto(d: Decision): AuditDecision {
  return d.grantScope && grants().has(d.grantScope) ? 'granted' : 'auto'
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
