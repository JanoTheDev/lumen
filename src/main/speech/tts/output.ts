// Muted-output check (04 T20) and the screen-reader rule (T21), kept pure for tests.
import type { OutputState } from './win-voices'

/** Muted, or the volume is so low nothing would be heard. */
export function silentOutput(s: OutputState): boolean {
  return s.muted || s.volume < 0.01
}

/**
 * One output check per spoken turn, shared by all its sentences. A failed or slow check
 * counts as "not muted": speaking into a muted device is better than never speaking.
 */
export class OutputGate {
  private checks = new Map<string, Promise<boolean>>()

  constructor(
    private readonly check: () => Promise<OutputState>,
    private readonly onMuted: (turnId: string) => void
  ) {}

  mutedFor(turnId: string): Promise<boolean> {
    let p = this.checks.get(turnId)
    if (!p) {
      p = this.check()
        .then((s) => {
          const muted = silentOutput(s)
          if (muted) this.onMuted(turnId)
          return muted
        })
        .catch(() => false)
      this.checks.set(turnId, p)
      if (this.checks.size > 20) this.checks.delete(this.checks.keys().next().value as string)
    }
    return p
  }

  /** Forget a turn's result (after unmute, so a repeat checks again). */
  forget(turnId: string): void {
    this.checks.delete(turnId)
  }
}

/**
 * Lumen's own voice stays quiet while a screen reader runs (it would talk over it), unless
 * the user asked for both. Answers then go to the screen reader through announce.
 */
export function ttsAllowed(screenReader: boolean, withScreenReader: boolean): boolean {
  return !screenReader || withScreenReader
}
