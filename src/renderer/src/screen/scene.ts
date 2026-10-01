// Scene diffing for the screen layer. Items are keyed (highlight id, mark number); an item
// that leaves the scene stays rendered as "exiting" for its exit animation, then drops. An
// item that comes back while exiting is live again with no re-entry.

export interface Present<T> {
  key: string
  item: T
  exiting: boolean
  /** When the item started exiting (ms); 0 while live. */
  since: number
}

export function reconcile<T>(
  prev: readonly Present<T>[],
  next: readonly T[],
  keyOf: (t: T) => string,
  now: number,
  exitMs: number
): Present<T>[] {
  const out: Present<T>[] = []
  const live = new Set<string>()
  for (const item of next) {
    const key = keyOf(item)
    if (live.has(key)) continue
    live.add(key)
    out.push({ key, item, exiting: false, since: 0 })
  }
  // Exiting items keep their old slot order after the live ones; they are drawn underneath.
  for (const p of prev) {
    if (live.has(p.key)) continue
    const since = p.exiting ? p.since : now
    if (now - since < exitMs) out.push({ key: p.key, item: p.item, exiting: true, since })
  }
  return out
}

/** Ms until the next exiting item should drop, or null when nothing is exiting. */
export function nextExpiry<T>(
  list: readonly Present<T>[],
  now: number,
  exitMs: number
): number | null {
  let best: number | null = null
  for (const p of list) {
    if (!p.exiting) continue
    const left = Math.max(0, p.since + exitMs - now)
    best = best === null ? left : Math.min(best, left)
  }
  return best
}

/**
 * The highlight label is left out when the buddy's label already says it (the pointer label
 * is "1/3: Click Compose" while the step label is "Click Compose").
 */
export function showHighlightLabel(
  label: string | undefined,
  buddyLabel: string | undefined
): boolean {
  if (!label) return false
  if (!buddyLabel) return true
  return !buddyLabel.toLowerCase().includes(label.toLowerCase())
}
