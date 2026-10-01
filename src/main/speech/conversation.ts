// Conversation mode: a double-tap on the assistant hotkey keeps Lumen listening. Every
// utterance is a query; once its turn has finished and the spoken reply is over, the mic opens
// again. Ends on another double-tap, Escape / a cancel word, the dictation hotkey, or after
// 5 minutes without a request. Pure: effects and timers are injected.
import type { Timers } from './activation'

export const IDLE_END_MS = 5 * 60_000
/**
 * Pause before listening again: lets a reply that is spoken only once the turn is done start
 * first, and keeps the answer's tail out of the recording.
 */
export const REARM_MS = 800

export interface ConversationEffects {
  /** Open the mic hands-free (ends on silence) for the next utterance. */
  listen(): void
  /** True while a recording is open or starting (no second one). */
  recording(): boolean
  /** Stop and drop whatever runs now (the user left the conversation). */
  cancel(): void
  status(text: string | null): void
}

export class Conversation {
  private on = false
  private speaking = false
  private idleTimer: unknown = null
  private rearmTimer: unknown = null
  /** The turn ended while the reply was still being spoken. */
  private waitingForQuiet = false

  constructor(
    private readonly fx: ConversationEffects,
    private readonly timers: Timers
  ) {}

  get active(): boolean {
    return this.on
  }

  /** Double-tap: start, or leave. Returns true when a conversation now runs. */
  toggle(): boolean {
    if (this.on) {
      this.end()
      this.fx.cancel()
      return false
    }
    this.on = true
    this.fx.status('Conversation on. Double-tap to end')
    this.touch()
    return true
  }

  /** Leaves without cancelling anything (Escape already did, or the dictation hotkey). */
  end(): void {
    if (!this.on) return
    this.on = false
    this.waitingForQuiet = false
    this.clear('idle')
    this.clear('rearm')
    this.fx.status(null)
  }

  /** A request started: the idle clock restarts. */
  touch(): void {
    if (!this.on) return
    this.clear('idle')
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null
      this.end()
    }, IDLE_END_MS)
  }

  /** The renderer finished a turn (answer shown, nothing heard, dropped transcript, error). */
  turnEnded(): void {
    if (!this.on) return
    if (this.speaking) {
      this.waitingForQuiet = true
      return
    }
    this.scheduleListen()
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking
    if (speaking) {
      // The reply started after the turn ended (spoken whole once done): wait for it.
      if (this.rearmTimer !== null) this.waitingForQuiet = true
      this.clear('rearm')
      return
    }
    if (this.on && this.waitingForQuiet) {
      this.waitingForQuiet = false
      this.scheduleListen()
    }
  }

  private scheduleListen(): void {
    this.clear('rearm')
    this.rearmTimer = this.timers.set(() => {
      this.rearmTimer = null
      if (!this.on || this.speaking || this.fx.recording()) return
      this.fx.listen()
    }, REARM_MS)
  }

  private clear(which: 'idle' | 'rearm'): void {
    const key = which === 'idle' ? 'idleTimer' : 'rearmTimer'
    if (this[key] !== null) this.timers.clear(this[key])
    this[key] = null
  }
}
