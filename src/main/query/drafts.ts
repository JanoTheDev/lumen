// Which waiting draft a review word is for. Several features keep a draft for a spoken review
// ("save it", "call it …", "read it back", "discard it"): skills, reply styles, buddies, coding
// skills and recorded lessons. Each one reports the time of its waiting draft here (when it was
// made or last read back / renamed), and a review word goes only to the newest one, whatever
// the order of the intercept chain.
//
// Bare cancel words ("no", "cancel", "forget it") are also the cancel words of running work.
// They discard a draft only when no turn is running and nothing was asked after the draft was
// shown; the explicit ones ("discard it", "throw it away", "don't save it") always discard.
import { hasActiveScope } from './cancel'

export type DraftKind = 'skill' | 'style' | 'buddy' | 'coding-skill' | 'lesson'

/** The time of the kind's waiting draft, or null when none waits (or it expired). */
export type DraftSource = () => number | null

const sources = new Map<DraftKind, DraftSource>()
let lastTurnAt = 0

/** Installs (or with null removes) the kind's source; a newer one replaces the old. */
export function setDraftSource(kind: DraftKind, source: DraftSource | null): void {
  if (source) sources.set(kind, source)
  else sources.delete(kind)
}

function at(source: DraftSource): number | null {
  try {
    return source()
  } catch {
    return null
  }
}

/** The newest waiting draft, or null. */
export function newestDraft(): { kind: DraftKind; at: number } | null {
  let best: { kind: DraftKind; at: number } | null = null
  for (const [kind, source] of sources) {
    const t = at(source)
    if (t !== null && (!best || t > best.at)) best = { kind, at: t }
  }
  return best
}

/** A review word is this draft's: no other kind has a newer waiting draft. */
export function isNewestDraft(kind: DraftKind, draftAt: number): boolean {
  for (const [k, source] of sources) {
    if (k === kind) continue
    const t = at(source)
    if (t !== null && t > draftAt) return false
  }
  return true
}

/** A user turn went to the assistant (it may show an answer after the draft). */
export function noteTurnStarted(now = Date.now()): void {
  lastTurnAt = Math.max(lastTurnAt, now)
}

/**
 * A bare "no" / "cancel" / "forget it" discards this draft: nothing runs, no turn started
 * after it, and it is the newest draft. Otherwise the words cancel the running work.
 */
export function bareCancelDiscards(kind: DraftKind, draftAt: number): boolean {
  return !hasActiveScope() && draftAt >= lastTurnAt && isNewestDraft(kind, draftAt)
}

/** A review command of this kind's draft is its own to answer (`bare`: a bare cancel word). */
export function claimsReview(
  kind: DraftKind,
  draftAt: number,
  c: { cmd: string; bare?: boolean }
): boolean {
  return c.bare ? bareCancelDiscards(kind, draftAt) : isNewestDraft(kind, draftAt)
}

/** Tests. */
export function resetDrafts(): void {
  sources.clear()
  lastTurnAt = 0
}
