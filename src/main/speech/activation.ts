// Assistant hotkey gestures, from raw down/up events.
//   hold mode: press and talk, release to send. A quick tap instead leaves the mic open and
//              ends on silence (or another tap), so a tap never records forever or is lost.
//   tap mode:  press once to start (ends on silence), press again to send early.
//   double-tap (both modes, when the effect is given): two quick taps toggle a conversation;
//              the recording the first tap opened keeps going.
// Recording starts on the press in both modes, so no audio is lost while deciding.

export type ActivationMode = 'hold' | 'tap'

export interface AssistantActivationEffects {
  /** Open the mic. `handsFree`: the recording ends on silence, not on release. */
  start(handsFree: boolean): void
  /** The open recording becomes hands-free. */
  handsFree(): void
  /** Stop recording and send what was said. */
  stop(): void
  /**
   * Two quick taps. Returns true when a recording is still open afterwards (a conversation
   * started on it), false when it ended (the conversation was left).
   */
  doubleTap?(): boolean
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** A press shorter than this is a tap. */
export const TAP_MS = 250
/** The second tap of a double-tap starts within this long after the first one ended. */
export const DOUBLE_TAP_GAP_MS = 350
/** Safety net: forget a hands-free session the renderer never reported as ended. */
export const SESSION_MAX_MS = 45_000

type State = 'idle' | 'holding' | 'hands-free' | 'stop-press' | 'double-press'

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class AssistantActivation {
  private state: State = 'idle'
  private downAt = 0
  private timer: unknown = null
  /** When the last quick tap was released, for double-tap detection. */
  private tapUpAt: number | null = null
  /** After a double-tap: a recording is still open. */
  private keepsRecording = false

  constructor(
    private readonly fx: AssistantActivationEffects,
    private readonly mode: () => ActivationMode,
    private readonly timers: Timers = realTimers,
    private readonly doubleTapOn: () => boolean = () => true
  ) {}

  get current(): State {
    return this.state
  }

  down(now = Date.now()): void {
    if (this.isSecondTap(now)) {
      this.tapUpAt = null
      this.clearTimer()
      this.state = 'double-press'
      this.downAt = now
      this.keepsRecording = this.fx.doubleTap!()
      return
    }
    switch (this.state) {
      case 'idle':
        this.downAt = now
        if (this.mode() === 'tap') {
          this.enterHandsFree()
          this.fx.start(true)
        } else {
          this.state = 'holding'
          this.fx.start(false)
        }
        return
      case 'hands-free':
        this.downAt = now
        this.clearTimer()
        this.state = 'stop-press'
        this.fx.stop()
        return
      default:
        // Key repeat while held.
        return
    }
  }

  up(now = Date.now()): void {
    const quick = now - this.downAt < TAP_MS
    if (this.state !== 'double-press') this.tapUpAt = quick ? now : null
    switch (this.state) {
      case 'holding':
        if (quick) {
          this.enterHandsFree()
          this.fx.handsFree()
          return
        }
        this.state = 'idle'
        this.fx.stop()
        return
      case 'stop-press':
        this.state = 'idle'
        return
      case 'double-press':
        if (this.keepsRecording) this.enterHandsFree()
        else this.state = 'idle'
        return
      default:
        return
    }
  }

  private isSecondTap(now: number): boolean {
    if (!this.fx.doubleTap || this.tapUpAt === null || !this.doubleTapOn()) return false
    if (this.state !== 'idle' && this.state !== 'hands-free') return false
    return now - this.tapUpAt <= DOUBLE_TAP_GAP_MS
  }

  /** The recording ended elsewhere (silence, no speech, Escape, error). */
  reset(): void {
    this.clearTimer()
    this.state = 'idle'
  }

  private enterHandsFree(): void {
    this.state = 'hands-free'
    this.clearTimer()
    this.timer = this.timers.set(() => {
      this.timer = null
      if (this.state === 'hands-free') this.state = 'idle'
    }, SESSION_MAX_MS)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
