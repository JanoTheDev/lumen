// Assistant hotkey gestures, from raw down/up events.
//   hold mode: press and talk, release to send. A quick tap instead leaves the mic open and
//              ends on silence (or another tap), so a tap never records forever or is lost.
//   tap mode:  press once to start (ends on silence), press again to send early.
// Recording starts on the press in both modes, so no audio is lost while deciding.

export type ActivationMode = 'hold' | 'tap'

export interface AssistantActivationEffects {
  /** Open the mic. `handsFree`: the recording ends on silence, not on release. */
  start(handsFree: boolean): void
  /** The open recording becomes hands-free. */
  handsFree(): void
  /** Stop recording and send what was said. */
  stop(): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** A press shorter than this is a tap. */
export const TAP_MS = 250
/** Safety net: forget a hands-free session the renderer never reported as ended. */
export const SESSION_MAX_MS = 45_000

type State = 'idle' | 'holding' | 'hands-free' | 'stop-press'

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class AssistantActivation {
  private state: State = 'idle'
  private downAt = 0
  private timer: unknown = null

  constructor(
    private readonly fx: AssistantActivationEffects,
    private readonly mode: () => ActivationMode,
    private readonly timers: Timers = realTimers
  ) {}

  get current(): State {
    return this.state
  }

  down(now = Date.now()): void {
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
    switch (this.state) {
      case 'holding':
        if (now - this.downAt < TAP_MS) {
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
      default:
        return
    }
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
