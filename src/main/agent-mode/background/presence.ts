// When a background task may speak up (skills-and-background-agents.md §2): only while the user
// is around (own input in the last 2 minutes), not in focus mode, and not in the middle of a
// turn of their own (then the notice waits for the turn to end).

export const PRESENT_MS = 2 * 60_000

export interface PresenceState {
  /** Time since the user's last keyboard or mouse input. */
  idleMs: number
  /** Focus mode / do not disturb (config agent.background.quiet). */
  quiet: boolean
  /** A query, dictation or confirm of the user's is in progress. */
  midTurn: boolean
}

export type NoticeVerdict = 'now' | 'after-turn' | 'list-only'

export function noticeVerdict(s: PresenceState): NoticeVerdict {
  if (s.quiet || s.idleMs >= PRESENT_MS) return 'list-only'
  return s.midTurn ? 'after-turn' : 'now'
}

/** Short spoken line for a finished task. */
export function doneLine(title: string, phase: 'done' | 'failed', summary: string): string {
  const head =
    phase === 'done' ? `Background task done: ${title}.` : `Background task failed: ${title}.`
  const first = summary.split(/(?<=[.!?])\s+/)[0]?.trim() ?? ''
  return first && first.length <= 160 ? `${head} ${first}` : head
}
