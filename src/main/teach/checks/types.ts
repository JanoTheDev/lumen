// Shared shape of every lesson check (plans 07 T14). A check starts with the step, watches
// for the user's action and resolves `result` with 'pass' once it sees it. evaluate() answers
// "is it done right now?" when the user says "done". cancel() stops all watching.
import type { Clock } from '../../a11y/timings'
import type { LessonStep } from '../lesson'
import type { CheckResult, Ports } from '../ports'

export interface CheckHandle {
  /** Resolves 'pass' when the action is observed; 'unknown' after cancel. */
  result: Promise<CheckResult>
  evaluate(): Promise<CheckResult>
  cancel(): void
  /** An `absent` check: true once the event it must not see was seen (an allOf then holds
   *  back its live pass). */
  vetoed?(): boolean
}

/** Vision cost guard shared by every vision check of one step. */
export interface VisionBudget {
  calls: number
  lastAt: number
  last: CheckResult | null
}

export interface CheckContext {
  ports: Ports
  clock: Clock
  step: LessonStep
  budget: VisionBudget
  log(msg: string): void
  /** First bridge answer per app + request in this lesson, for `since: "lesson"` checks
   *  (filled by every bridge query of the lesson; absent outside a lesson). */
  lessonStart?: Map<string, unknown>
}

export function newBudget(): VisionBudget {
  return { calls: 0, lastAt: -Infinity, last: null }
}

/** A result promise that can be settled from outside, once. */
export function settleable(): {
  promise: Promise<CheckResult>
  settle(r: CheckResult): void
  /** True once it passed (not after a cancel). */
  passed(): boolean
} {
  let done = false
  let value: CheckResult | null = null
  let resolve!: (r: CheckResult) => void
  const promise = new Promise<CheckResult>((r) => (resolve = r))
  return {
    promise,
    settle: (r) => {
      if (done) return
      done = true
      value = r
      resolve(r)
    },
    passed: () => value === 'pass'
  }
}

/** Repeats `fn` every `ms` on the clock until stop(); one run at a time. */
export function poll(clock: Clock, ms: number, fn: () => Promise<void>): { stop(): void } {
  let stopped = false
  let handle: unknown = null
  const tick = (): void => {
    handle = null
    if (stopped) return
    fn()
      .catch(() => {})
      .finally(() => {
        if (!stopped) handle = clock.setTimeout(tick, ms)
      })
  }
  handle = clock.setTimeout(tick, 0)
  return {
    stop: () => {
      stopped = true
      if (handle) clock.clearTimeout(handle)
      handle = null
    }
  }
}
