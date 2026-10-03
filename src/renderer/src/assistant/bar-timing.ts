// Timing helpers for the assistant bar, kept free of React so they can be tested: the newest
// pushed state once per frame, card sizes only when they change, the auto-close countdown as
// one animation, and how far a row glides after a layout change.
import type { AssistantPhase } from '@shared/events'

/** Runs `fn` once, on the next frame; returns a cancel. */
export type FrameSchedule = (fn: () => void) => () => void

/** A frame, or 100 ms when frames stop (a hidden window gets no frames). */
export const nextFrame: FrameSchedule = (fn) => {
  let done = false
  const run = (): void => {
    if (done) return
    done = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
    fn()
  }
  const raf = requestAnimationFrame(run)
  const timer = setTimeout(run, 100)
  return () => {
    done = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
  }
}

/** Keeps only the newest value pushed within a frame and applies it on that frame. */
export function latestPerFrame<T>(
  apply: (value: T) => void,
  schedule: FrameSchedule = nextFrame
): { push: (value: T) => void; cancel: () => void } {
  let pending: { value: T } | null = null
  let cancelFrame: (() => void) | null = null
  return {
    push(value) {
      pending = { value }
      if (cancelFrame) return
      cancelFrame = schedule(() => {
        cancelFrame = null
        const p = pending
        pending = null
        if (p) apply(p.value)
      })
    },
    cancel() {
      cancelFrame?.()
      cancelFrame = null
      pending = null
    }
  }
}

/** Reports a size at most once per frame, and only when it differs from the last report. */
export function sizeReporter(
  report: (size: { w: number; h: number }) => void,
  schedule: FrameSchedule = nextFrame
): { size: (w: number, h: number) => void; cancel: () => void } {
  let last: { w: number; h: number } | null = null
  const frame = latestPerFrame<{ w: number; h: number }>((s) => {
    if (last && last.w === s.w && last.h === s.h) return
    last = s
    report(s)
  }, schedule)
  return { size: (w, h) => frame.push({ w, h }), cancel: frame.cancel }
}

/** Phases where a turn is still running; a file pointed at during the turn shows at its end. */
const TURN_BUSY = new Set<AssistantPhase>([
  'listening',
  'transcribing',
  'thinking',
  'acting',
  'confirm'
])

/** When the shared-files row reads the list again: the bar shows or hides, or a turn ends. */
export function filesRefreshKey(visible: boolean, phase: AssistantPhase): string {
  return `${visible}|${visible && TURN_BUSY.has(phase)}`
}

/** The part of the Web Animations API the countdown uses. */
export interface CountdownAnimation {
  currentTime: number | null | CSSNumberish
  onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null
  play(): void
  pause(): void
  cancel(): void
}

export interface CountdownTarget {
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): CountdownAnimation
}

/**
 * The auto-close line: shrinks from full to nothing over the answer's time, pauses while the
 * pointer or focus is on the card, starts over on `reset()`, and calls `onDone` at the end.
 */
export class Countdown {
  private anim: CountdownAnimation | null = null
  private el: CountdownTarget | null = null
  private duration = 0
  /** Time already run, carried to a new line element. */
  private carried = 0

  constructor(private readonly onDone: () => void) {}

  reset(): void {
    this.anim?.cancel()
    this.anim = null
    this.el = null
    this.carried = 0
  }

  update(el: CountdownTarget | null, running: boolean, durationMs: number): void {
    if (this.anim && (el !== this.el || durationMs !== this.duration)) {
      this.carried = durationMs === this.duration ? elapsed(this.anim) : 0
      this.anim.cancel()
      this.anim = null
    }
    if (!el || durationMs <= 0) return
    if (!running) {
      this.anim?.pause()
      return
    }
    if (!this.anim) {
      const anim = el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
        duration: durationMs,
        easing: 'linear',
        fill: 'forwards'
      })
      if (this.carried > 0) anim.currentTime = Math.min(this.carried, durationMs)
      anim.onfinish = () => {
        if (this.anim === anim) this.onDone()
      }
      this.anim = anim
      this.el = el
      this.duration = durationMs
    }
    this.anim.play()
  }
}

function elapsed(a: CountdownAnimation): number {
  const t = a.currentTime
  return typeof t === 'number' ? t : 0
}

/** A row's distance from the card's bottom edge and its height. */
export interface RowBox {
  d: number
  h: number
}

/**
 * Where a row that moved starts its glide (`from`, px down from its new place) and how much of
 * its growth to hide while it glides. Null when it did not move.
 */
export function rowGlide(
  before: RowBox | undefined,
  now: RowBox,
  running?: { y: number; grew: number }
): { from: number; grew: number } | null {
  if (before === undefined || Math.abs(before.d - now.d) < 0.5) return null
  const from = (running?.y ?? 0) + now.d - before.d
  // Growth still hidden by a running glide counts on top of this one.
  const grew = Math.max(0, now.h - before.h + (running ? Math.min(running.y, running.grew) : 0))
  return { from, grew }
}
