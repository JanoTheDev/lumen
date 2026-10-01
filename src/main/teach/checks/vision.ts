// vision: a yes/no question about the before-frame (step start) and an after-frame. Costly,
// so it is guarded:
//   - It runs only at a settle: the screen changed, then stayed still ≥ 700 ms, measured on
//     low-res frames at 2 fps. A screen that is back to how it started does not count.
//   - At most one call per 3 s and 6 per step (shared by the step's vision checks); after
//     that only "done" (evaluate) asks again.
//   - evaluate() within 3 s of the last call reuses its answer.
import type { CheckResult, Frame } from '../ports'
import type { CheckContext, CheckHandle } from './types'
import { settleable } from './types'

export const SETTLE_TICK_MS = 500
export const SETTLE_STILL_MS = 700
export const MIN_GAP_MS = 3000
export const MAX_CALLS_PER_STEP = 6
/** Diff ratios (share of changed pixels) for "changed" and "still". */
export const CHANGED = 0.02
export const STILL = 0.005

export function start(spec: { prompt: string }, ctx: CheckContext): CheckHandle {
  const { ports, clock, budget } = ctx
  const r = settleable()
  const ac = new AbortController()
  let before: Frame | null = null
  let beforeLow: Frame | null = null
  let prevLow: Frame | null = null
  let changed = false
  let stillSince: number | null = null
  let handle: unknown = null
  let stopped = false
  let busy = false

  const ask = async (): Promise<CheckResult> => {
    if (!before) return 'unknown'
    const after = await ports.screen.capture().catch(() => null)
    if (!after || ac.signal.aborted) return 'unknown'
    budget.calls++
    budget.lastAt = clock.now()
    ctx.log(`vision call ${budget.calls} for step ${ctx.step.id}`)
    const res = await ports.verify
      .vision(spec.prompt, before.id, after.id, ac.signal)
      .catch(() => 'unknown' as const)
    budget.last = res
    return res
  }

  const stop = (): void => {
    stopped = true
    if (handle) clock.clearTimeout(handle)
    handle = null
  }

  const schedule = (): void => {
    if (!stopped) handle = clock.setTimeout(() => void tick(), SETTLE_TICK_MS)
  }

  const tick = async (): Promise<void> => {
    handle = null
    if (stopped || busy) return schedule()
    busy = true
    try {
      const cur = await ports.screen.capture({ low: true }).catch(() => null)
      if (!cur || stopped) return
      const d = prevLow ? ports.screen.diff(prevLow, cur) : null
      prevLow = cur
      if (d === null) return
      const now = clock.now()
      if (d > STILL) {
        if (d >= CHANGED) changed = true
        stillSince = null
        return
      }
      if (!changed) return
      stillSince ??= now
      if (now - stillSince < SETTLE_STILL_MS) return
      // Settled. Back to the starting picture means nothing happened.
      const fromStart = beforeLow ? ports.screen.diff(beforeLow, cur) : null
      if (fromStart !== null && fromStart <= STILL) {
        changed = false
        stillSince = null
        return
      }
      if (budget.calls >= MAX_CALLS_PER_STEP) {
        ctx.log('vision: step budget used, waiting for "done"')
        stop()
        return
      }
      if (now - budget.lastAt < MIN_GAP_MS) return // retried on the next tick
      changed = false
      stillSince = null
      const res = await ask()
      if (res === 'pass') {
        stop()
        r.settle('pass')
      }
    } finally {
      busy = false
      schedule()
    }
  }

  void (async () => {
    before = await ports.screen.capture().catch(() => null)
    beforeLow = await ports.screen.capture({ low: true }).catch(() => null)
    prevLow = beforeLow
    if (!before) ctx.log('vision: no before-frame, waiting for "done"')
    else schedule()
  })()

  return {
    result: r.promise,
    evaluate: async () => {
      if (r.passed()) return 'pass'
      if (budget.last && clock.now() - budget.lastAt < MIN_GAP_MS) return budget.last
      const res = await ask()
      if (res === 'pass') r.settle('pass')
      return res
    },
    cancel: () => {
      stop()
      ac.abort()
      r.settle('unknown')
    }
  }
}
