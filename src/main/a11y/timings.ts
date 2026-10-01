// Adjustable timing (06 T15, WCAG 2.2.1): every main-side auto-dismiss reads its length from
// here, never from a hard-coded number. Pure helpers plus a pausable timer; no Electron.
//
//   status line      max(requested, a11y.timings.statusHoldMs)
//   answer card      answerAutoCloseMs (0 = never), "longer" doubles it
//   caption          a11y.timings.captionHoldMs (0 = until the next utterance)
//   confirm          a11y.timings.confirmCountdownMs: unset = the app's own countdown,
//                    0 = wait for the user, else that many ms

export interface TimingConfig {
  answerAutoCloseMs: number
  a11y: {
    timings: { statusHoldMs: number; captionHoldMs: number; confirmCountdownMs?: number }
  }
}

/** "Longer" multiplies the remaining time by this. */
export const EXTEND_FACTOR = 2
/** The longest anything is extended to, so repeated "longer" stays finite. */
export const MAX_EXTENDED_MS = 600_000

/** How long a status line with a requested hold stays; 0/undefined keeps it until replaced. */
export function statusHoldMs(cfg: TimingConfig, requestedMs?: number): number | undefined {
  if (!requestedMs || requestedMs <= 0) return requestedMs
  return Math.max(requestedMs, cfg.a11y.timings.statusHoldMs)
}

/** Answer auto-close in ms (0 = never), times the user's "longer" factor. */
export function answerAutoCloseMs(cfg: TimingConfig, factor = 1): number {
  const base = cfg.answerAutoCloseMs
  if (base <= 0) return 0
  return Math.min(MAX_EXTENDED_MS, Math.round(base * Math.max(1, factor)))
}

export function captionHoldMs(cfg: TimingConfig): number {
  return Math.max(0, cfg.a11y.timings.captionHoldMs)
}

/** Confirm countdown: undefined means no countdown (the card waits for yes or no). */
export function confirmCountdownMs(cfg: TimingConfig, appDefaultMs: number): number | undefined {
  const set = cfg.a11y.timings.confirmCountdownMs
  if (set === undefined) return appDefaultMs > 0 ? appDefaultMs : undefined
  return set > 0 ? set : undefined
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * One auto-dismiss timer that pauses while the user is on it (hover, focus, dwell) and can be
 * extended. Pausing keeps the remaining time; resuming never gives less than `minResumeMs`.
 */
export class PausableTimer {
  private handle: unknown = null
  private deadline = 0
  private remaining = 0
  private fn: (() => void) | null = null
  private pausedBy = new Set<string>()

  constructor(
    private readonly clock: Clock = realClock,
    private readonly minResumeMs = 1500
  ) {}

  get running(): boolean {
    return this.fn !== null
  }

  get paused(): boolean {
    return this.pausedBy.size > 0
  }

  /** Time left, or 0 when nothing is scheduled. */
  left(): number {
    if (!this.fn) return 0
    return this.handle ? Math.max(0, this.deadline - this.clock.now()) : this.remaining
  }

  start(ms: number, fn: () => void): void {
    this.clear()
    this.fn = fn
    this.remaining = ms
    if (!this.paused) this.arm(ms)
  }

  clear(): void {
    if (this.handle) this.clock.clearTimeout(this.handle)
    this.handle = null
    this.fn = null
    this.remaining = 0
  }

  /** Pauses for one reason ("hover", "dwell", …); it resumes once every reason is gone. */
  pause(reason: string): void {
    const was = this.paused
    this.pausedBy.add(reason)
    if (was || !this.handle) return
    this.remaining = Math.max(0, this.deadline - this.clock.now())
    this.clock.clearTimeout(this.handle)
    this.handle = null
  }

  resume(reason: string): void {
    if (!this.pausedBy.delete(reason) || this.paused || !this.fn) return
    this.arm(Math.max(this.remaining, this.minResumeMs))
  }

  /** "Longer": the time left times `factor`, capped. False when nothing is counting down. */
  extend(factor = EXTEND_FACTOR): boolean {
    if (!this.fn) return false
    const next = Math.min(MAX_EXTENDED_MS, Math.round(Math.max(this.left(), 1) * factor))
    this.remaining = next
    if (this.handle) this.arm(next)
    return true
  }

  private arm(ms: number): void {
    if (this.handle) this.clock.clearTimeout(this.handle)
    this.deadline = this.clock.now() + ms
    this.remaining = ms
    this.handle = this.clock.setTimeout(() => {
      this.handle = null
      const fn = this.fn
      this.fn = null
      fn?.()
    }, ms)
  }
}
