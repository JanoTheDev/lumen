// Dictation hotkey gestures, from raw down/up events:
//   hold            → record while held, type on release
//   double-tap      → hands-free: record until the user stops talking or taps once more
//   single quick tap → nothing is typed; a hint explains the two gestures
// Recording starts on the first press, so a double-tap loses no audio.

export interface ActivationEffects {
  /** Open the mic (hold mode until told otherwise). */
  start(): void
  /** Switch the open recording to hands-free (ends on silence or the next tap). */
  handsFree(): void
  /** Stop recording and type what was said. */
  stop(): void
  /** Drop the recording; `tap` = it was a lone quick tap. */
  cancel(reason: 'tap'): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** A press shorter than this is a tap, not a hold. */
export const TAP_MS = 300
/** Max gap between the first tap's release and the second press. */
export const DOUBLE_TAP_GAP_MS = 400
/** Hands-free safety net in case the renderer never reports the end. */
export const HANDS_FREE_MAX_MS = 3 * 60_000

type State = 'idle' | 'holding' | 'tap-pending' | 'second-press' | 'hands-free' | 'stop-press'

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class DictationActivation {
  private state: State = 'idle'
  private downAt = 0
  private timer: unknown = null

  constructor(
    private readonly fx: ActivationEffects,
    private readonly timers: Timers = realTimers
  ) {}

  get current(): State {
    return this.state
  }

  get active(): boolean {
    return this.state !== 'idle'
  }

  down(now = Date.now()): void {
    switch (this.state) {
      case 'idle':
        this.state = 'holding'
        this.downAt = now
        this.fx.start()
        return
      case 'tap-pending':
        this.clearTimer()
        this.state = 'second-press'
        this.fx.handsFree()
        this.arm(HANDS_FREE_MAX_MS, () => this.finish())
        return
      case 'hands-free':
        this.clearTimer()
        this.state = 'stop-press'
        this.fx.stop()
        return
      default:
        // Key repeat while held, or a press during the stop press.
        return
    }
  }

  up(now = Date.now()): void {
    switch (this.state) {
      case 'holding':
        if (now - this.downAt >= TAP_MS) {
          this.state = 'idle'
          this.fx.stop()
          return
        }
        this.state = 'tap-pending'
        this.arm(DOUBLE_TAP_GAP_MS, () => {
          this.state = 'idle'
          this.fx.cancel('tap')
        })
        return
      case 'second-press':
        this.state = 'hands-free'
        return
      case 'stop-press':
        this.state = 'idle'
        return
      default:
        return
    }
  }

  /** The session ended elsewhere (silence auto-stop, Escape, error): back to idle. */
  reset(): void {
    this.clearTimer()
    this.state = 'idle'
  }

  private finish(): void {
    this.timer = null
    if (this.state === 'hands-free' || this.state === 'second-press') {
      this.state = 'idle'
      this.fx.stop()
    }
  }

  private arm(ms: number, fn: () => void): void {
    this.clearTimer()
    this.timer = this.timers.set(() => {
      this.timer = null
      fn()
    }, ms)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
