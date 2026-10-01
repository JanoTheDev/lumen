// Where dictation goes when there is no text field (04 T45 scratchpad), and how long the
// recording ran (for the T46 words-per-minute). Pure.
import { isTerminalTarget, type FocusTarget } from './terminal-guard'

/** Roles that can take typed text even when UI Automation does not call them editable. */
const MAYBE_TEXT_ROLES = new Set(['edit', 'document', 'combobox', 'custom', 'group', 'pane', ''])

/** Focus is known and is clearly not a text field (a button, a list, a window). */
export function noTextField(t: FocusTarget): boolean {
  if (!t.uia || t.editable || t.password || isTerminalTarget(t)) return false
  return !MAYBE_TEXT_ROLES.has(t.role.toLowerCase())
}

/** A failed insert into a known, non-editable element is kept as a note. */
export function scratchpadOnFailure(t: FocusTarget): boolean {
  return t.uia && !t.editable && !t.password
}

/** Recordings shorter or longer than this are not counted for speaking pace. */
const MIN_MS = 300
const MAX_MS = 10 * 60_000
/** A stop older than this belongs to an earlier recording. */
const STALE_MS = 2 * 60_000

/** Start and stop of the last recording; `take` hands out its length once. */
export class RecordingClock {
  private startedAt: number | null = null
  private stoppedAt: number | null = null

  start(now = Date.now()): void {
    this.startedAt = now
    this.stoppedAt = null
  }

  stop(now = Date.now()): void {
    if (this.startedAt !== null && this.stoppedAt === null) this.stoppedAt = now
  }

  reset(): void {
    this.startedAt = null
    this.stoppedAt = null
  }

  /** The recording's length in ms, or undefined when unknown; resets the clock. */
  take(now = Date.now()): number | undefined {
    const { startedAt, stoppedAt } = this
    this.reset()
    if (startedAt === null || stoppedAt === null || now - stoppedAt > STALE_MS) return undefined
    const ms = stoppedAt - startedAt
    return ms >= MIN_MS && ms <= MAX_MS ? ms : undefined
  }
}
