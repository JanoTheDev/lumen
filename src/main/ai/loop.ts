// The observe → decide → act → verify loop (T19), shared by plan execution, research,
// follow-up chains and (later) 08's agent mode:
//
//   for step: before = observe() ; decision = decide(step, before) ; if no actions: done
//             if risky → await confirm ; act(actions) ; settle ; after = observe()
//             verify(step, before, after) ; retry / replan / next
//
// The `after` observation is the next step's `before`, so a step costs one capture. Retries
// are idempotent: text a previous attempt typed is not typed again when the field (UIA
// value, else OCR) already shows it, and a retry refines every click target instead of
// repeating the same click.
import type { Action, ModelResponse, Rect } from '@shared/types'
import { CancelledError } from '../query/cancel'
import type { QueryContext } from '../query/context'
import type { ExecuteResult } from '../actions/executor'
import type { StepRecord } from './planner'
import { checksFor, type Observation, type Verdict, type VerifyRequest } from './verify'
import type { Observed } from './observe'
import { log } from '../logger'

export interface LoopStep {
  intent: string
  successCriteria?: string
  risky?: boolean
}

export interface StepState {
  goal: string
  step: LoopStep
  /** 1-based number of this step in the run; total = steps known so far. */
  index: number
  total: number
  history: StepRecord[]
  /** 0 on the first try; > 0 on retries. */
  attempt: number
  /** Why the previous attempt failed (verifier reason), on retries. */
  lastFailure?: string
  ctx: QueryContext
}

export interface Decision {
  response: ModelResponse
  /** Actions to run now; none = the step is complete with `response` (answer, locate...). */
  actions: Action[]
  /** Stop the whole run after this step (research answer, follow-up chain end). */
  done?: boolean
  /** A step to run right after this one (follow-up, research continuation). */
  next?: LoopStep
  /** The model flagged the actions as risky (sends, deletes...). */
  risky?: boolean
}

export interface ActOptions {
  signal: AbortSignal
  /** Refine every click target (retries pick a different target source). */
  forceRefine: boolean
}

export interface LoopDeps {
  observe(signal: AbortSignal): Promise<Observed>
  decide(state: StepState, signal: AbortSignal): Promise<Decision>
  act(actions: Action[], opts: ActOptions): Promise<ExecuteResult>
  /** Waits until the screen reacted (title / focus change, frames still; max 1.5 s). */
  settle(before: Observation, signal: AbortSignal): Promise<unknown>
  verify(
    req: VerifyRequest,
    before: Observation,
    after: Observation,
    signal: AbortSignal
  ): Promise<Verdict>
  /** 08's confirm hook for risky steps; false = the user said no. Absent = allowed. */
  confirm?(step: LoopStep, decision: Decision, signal: AbortSignal): Promise<boolean>
  /** New remaining steps after a step failed for good; null = stop. */
  replan?(
    failed: { step: LoopStep; reason: string },
    history: StepRecord[],
    now: Observed,
    signal: AbortSignal
  ): Promise<LoopStep[] | null>
  /** Whether `text` already shows in the focused field or on screen (idempotent retry). */
  alreadyTyped?(text: string, now: Observed, signal: AbortSignal): Promise<boolean>
  progress?(p: {
    index: number
    total: number
    intent: string
    status: 'running' | 'done' | 'failed'
  }): void
}

export interface LoopOptions {
  goal: string
  steps: LoopStep[]
  /** Hard cap on executed steps (config ai.maxSteps / ai.maxFollowUps). */
  maxSteps: number
  /** Retries per step after the first attempt. Default 2. */
  maxRetries?: number
  /** Verify each step (plans: yes; research and follow-ups decide again anyway). */
  verify: boolean
  /** Replans allowed per run. Default 1. */
  maxReplans?: number
  /** A scroll that hits the page bottom ends the run unless this is set (research). */
  continueAtBottom?: boolean
  /** The turn's existing observation, used as the first step's `before` (no extra capture). */
  start?: Observed
  signal: AbortSignal
}

export type LoopStatus = 'done' | 'failed' | 'max-steps' | 'denied' | 'blocked' | 'bottom'

export interface LoopResult {
  status: LoopStatus
  /** The last non-action reply (answer, locate...), when a step ended with one. */
  final?: ModelResponse
  history: StepRecord[]
  steps: number
  /** The latest observation (its context is what the final reply was grounded on). */
  last?: Observed
}

const typedTexts = (actions: Action[]): string[] =>
  actions.flatMap((a) => (a.type === 'type' && a.text ? [a.text] : []))

/** Drops `type` actions whose text a previous attempt typed and the screen already shows. */
async function withoutRetype(
  actions: Action[],
  typed: Set<string>,
  now: Observed,
  deps: LoopDeps,
  signal: AbortSignal
): Promise<Action[]> {
  if (!typed.size || !deps.alreadyTyped) return actions
  const out: Action[] = []
  for (const a of actions) {
    if (a.type === 'type' && typed.has(a.text) && (await deps.alreadyTyped(a.text, now, signal))) {
      log('retry', `"${a.text.slice(0, 40)}" is already in the field, not typing it again`)
      continue
    }
    out.push(a)
  }
  return out
}

function abort(signal: AbortSignal): never {
  throw signal.reason instanceof Error ? signal.reason : new CancelledError()
}

export async function runLoop(opts: LoopOptions, deps: LoopDeps): Promise<LoopResult> {
  const { signal } = opts
  const maxRetries = opts.maxRetries ?? 2
  let replans = opts.maxReplans ?? 1
  const agenda = [...opts.steps]
  const history: StepRecord[] = []
  let count = 0
  let final: ModelResponse | undefined
  let last: Observed | undefined = opts.start
  const result = (status: LoopStatus): LoopResult => ({
    status,
    final,
    history,
    steps: count,
    last
  })

  while (agenda.length) {
    if (count >= opts.maxSteps) {
      log('fail', `stopped at the step limit (${opts.maxSteps})`)
      return result('max-steps')
    }
    const step = agenda.shift() as LoopStep
    count++
    const index = count
    const total = count + agenda.length
    log('step', `${index}/${total} ${step.intent}`)
    deps.progress?.({ index, total, intent: step.intent, status: 'running' })
    const typed = new Set<string>()
    let attempt = 0
    let lastFailure: string | undefined

    for (;;) {
      if (signal.aborted) abort(signal)
      const before = last ?? (await deps.observe(signal))
      last = undefined
      const decision = await deps.decide(
        { goal: opts.goal, step, index, total, history, attempt, lastFailure, ctx: before.ctx },
        signal
      )
      if (signal.aborted) abort(signal)
      last = before

      if (!decision.actions.length) {
        final = decision.response
        history.push({ intent: step.intent, ok: true })
        deps.progress?.({ index, total, intent: step.intent, status: 'done' })
        if (decision.done) return result('done')
        if (decision.next) agenda.unshift(decision.next)
        break
      }

      if ((step.risky || decision.risky) && deps.confirm) {
        const yes = await deps.confirm(step, decision, signal)
        if (signal.aborted) abort(signal)
        if (!yes) {
          log('skip', `risky step declined: ${step.intent}`)
          history.push({ intent: step.intent, ok: false, note: 'declined' })
          return result('denied')
        }
      }

      const actions = attempt
        ? await withoutRetype(decision.actions, typed, before, deps, signal)
        : decision.actions
      if (!actions.length) {
        // Everything this retry would do (typing) is already on screen: the step is done.
        history.push({ intent: step.intent, ok: true, note: 'already typed' })
        deps.progress?.({ index, total, intent: step.intent, status: 'done' })
        if (decision.next) agenda.unshift(decision.next)
        break
      }
      const ran = await deps.act(actions, { signal, forceRefine: attempt > 0 })
      if (ran.cancelled || signal.aborted) abort(signal)
      if (ran.blocked) {
        history.push({ intent: step.intent, ok: false, note: 'blocked by the safety policy' })
        return result('blocked')
      }
      typedTexts(actions).forEach((t) => typed.add(t))

      await deps.settle(before.obs, signal)
      const after = await deps.observe(signal)
      last = after
      const verdict: Verdict = opts.verify
        ? await deps.verify(
            verifyRequest(step, decision.actions, ran.targets),
            before.obs,
            after.obs,
            signal
          )
        : { ok: true, confidence: 1, reason: 'not verified', evidence: 'diff' }
      if (signal.aborted) abort(signal)

      if (verdict.ok) {
        history.push({ intent: step.intent, ok: true })
        deps.progress?.({ index, total, intent: step.intent, status: 'done' })
        if (ran.reachedBottom && !opts.continueAtBottom) return result('bottom')
        if (decision.done) {
          final = decision.response
          return result('done')
        }
        if (decision.next) agenda.unshift(decision.next)
        break
      }

      attempt++
      lastFailure = verdict.reason
      if (attempt <= maxRetries) {
        log('retry', `${attempt}/${maxRetries} ${step.intent}: ${verdict.reason}`)
        continue
      }
      log('fail', `step failed after ${maxRetries} retries: ${step.intent} (${verdict.reason})`)
      history.push({ intent: step.intent, ok: false, note: verdict.reason })
      deps.progress?.({ index, total, intent: step.intent, status: 'failed' })
      const next =
        replans-- > 0 && deps.replan
          ? await deps.replan({ step, reason: verdict.reason }, history, after, signal)
          : null
      if (signal.aborted) abort(signal)
      if (!next?.length) return result('failed')
      agenda.splice(0, agenda.length, ...next)
      break
    }
  }
  return result('done')
}

function verifyRequest(step: LoopStep, actions: Action[], targets: Rect[]): VerifyRequest {
  return {
    description: step.intent,
    successCriteria: step.successCriteria,
    checks: checksFor(actions, targets),
    region: targets[0]
  }
}
