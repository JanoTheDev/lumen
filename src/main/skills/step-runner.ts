// Runs a skill's steps.json without the model (11 T04). For every step: find the target in a
// fresh UI Automation snapshot (it may take a moment to appear), check the skill's permissions,
// run the actions through the injected executor, then verify: the step's `expect` when it has
// one, else that the executor ran it. Anything that does not match the recording (a missing
// target, a failed check, an action that did nothing) is drift: the run stops there and the
// caller hands the rest to the model. A policy or permission refusal is not drift: it ends the
// run. Pure: every side effect is a port.
import type { Action, ElementNode } from '@shared/types'
import { describeSkillStep, findElement, stepActions, type SkillStep, type WaitCond } from './steps'

export const FIND_TIMEOUT_MS = 4000
export const EXPECT_TIMEOUT_MS = 5000
export const FIND_POLL_MS = 250

export interface StepExec {
  /** Actions that ran. */
  executed: number
  /** The safety policy or the user stopped it (E_DENIED). */
  denied?: string
  cancelled?: boolean
}

export interface StepPorts {
  /** Every element of the foreground window now (physical px). */
  elements(signal: AbortSignal): Promise<ElementNode[]>
  /** Runs one batch through the input lane and the policy gate. */
  execute(actions: Action[], signal: AbortSignal): Promise<StepExec>
  waitFor(
    cond: WaitCond,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<{ ok: boolean; detail: string }>
  /** The skill's permission check for a step; a string is the refusal. */
  permit?(step: SkillStep, signal: AbortSignal): Promise<string | null>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  /** Step `i` (0-based) starts. */
  progress?(i: number, total: number, label: string): void
}

export type StepsOutcome =
  | { status: 'done'; ran: number; actions: number }
  | { status: 'denied'; at: number; reason: string; ran: number; actions: number }
  | { status: 'drift'; at: number; reason: string; ran: number; actions: number }

async function locate(
  step: SkillStep,
  ports: StepPorts,
  signal: AbortSignal
): Promise<ElementNode | null> {
  if (!('target' in step) || !step.target) return null
  const until = ports.now() + (step.timeoutMs ?? FIND_TIMEOUT_MS)
  for (;;) {
    const hit = findElement(await ports.elements(signal), step.target)
    if (hit) return hit
    if (ports.now() >= until) return null
    await ports.sleep(FIND_POLL_MS, signal)
  }
}

/**
 * Runs `steps` (placeholders already filled). `labels` are the words shown per step (the
 * unfilled steps' descriptions, so typed values are not echoed on the bar).
 */
export async function runSkillSteps(
  steps: readonly SkillStep[],
  ports: StepPorts,
  signal: AbortSignal,
  labels: readonly string[] = steps.map(describeSkillStep)
): Promise<StepsOutcome> {
  let actions = 0
  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) throw signal.reason
    const step = steps[i]
    const label = labels[i] ?? describeSkillStep(step)
    ports.progress?.(i, steps.length, label)
    const refusal = await ports.permit?.(step, signal)
    if (refusal) return { status: 'denied', at: i, reason: refusal, ran: i, actions }

    if (step.do === 'wait') {
      const r = await ports.waitFor(step.for, step.timeoutMs ?? EXPECT_TIMEOUT_MS, signal)
      if (!r.ok) return drift(i, `${label}: not there (${r.detail})`)
      continue
    }

    const el = await locate(step, ports, signal)
    if ('target' in step && step.target && !el)
      return drift(i, `${label}: ${describeTarget(step)} is not on screen`)

    const batch = stepActions(step, el)
    if (!batch.length) return drift(i, `${label}: nothing to do`)
    const r = await ports.execute(batch, signal)
    actions += r.executed
    if (r.cancelled || signal.aborted) throw signal.reason ?? new Error('cancelled')
    if (r.denied) return { status: 'denied', at: i, reason: r.denied, ran: i, actions }
    if (r.executed < batch.length) return drift(i, `${label}: it did not go through`)

    if (step.expect) {
      const v = await ports.waitFor(step.expect, step.timeoutMs ?? EXPECT_TIMEOUT_MS, signal)
      if (!v.ok) return drift(i, `${label}: the check failed (${v.detail})`)
    }
  }
  return { status: 'done', ran: steps.length, actions }

  function drift(at: number, reason: string): StepsOutcome {
    return { status: 'drift', at, reason, ran: at, actions }
  }
}

function describeTarget(step: SkillStep): string {
  const t = 'target' in step ? step.target : undefined
  return `“${t?.name ?? t?.automationId ?? '?'}”${t?.role ? ` (${t.role})` : ''}`
}

/** The model's first turn after drift: what already ran and where it went off. */
export function driftNote(
  steps: readonly SkillStep[],
  outcome: Extract<StepsOutcome, { status: 'drift' }>,
  labels: readonly string[] = steps.map(describeSkillStep)
): string {
  const done = labels.slice(0, outcome.ran)
  const rest = labels.slice(outcome.at)
  return [
    'This skill has recorded steps. They ran without you until the screen stopped matching.',
    done.length
      ? `Already done: ${done.map((l, i) => `${i + 1}. ${l}`).join('; ')}.`
      : 'Nothing ran yet.',
    `Went off at step ${outcome.at + 1}: ${outcome.reason}.`,
    `Still to do (the recording, adapt it to the screen): ${rest.map((l, i) => `${outcome.at + i + 1}. ${l}`).join('; ')}.`,
    'Observe first, then finish the task. Do not redo the steps that are already done.'
  ].join('\n')
}
