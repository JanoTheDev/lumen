// Assistive tech running on this PC (agent `a11y_state` once, then `a11y-state` events): the
// announce policy needs the screen reader, coexistence (T20) needs Voice Access / Dragon.

export type ScreenReader = 'nvda' | 'jaws' | 'narrator' | 'other' | null

export interface AtState {
  screenReader: ScreenReader
  voiceControl: string[]
}

const READERS = new Set(['nvda', 'jaws', 'narrator', 'other'])

let state: AtState = { screenReader: null, voiceControl: [] }
const listeners = new Set<(next: AtState, prev: AtState) => void>()

/** Runs `fn` whenever the assistive-tech state changes; returns an unsubscribe. */
export function onAtStateChange(fn: (next: AtState, prev: AtState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function atState(): AtState {
  return state
}

export function screenReaderActive(): boolean {
  return state.screenReader !== null
}

/** Accepts the agent reply; anything malformed leaves the state unchanged. Returns true on change. */
export function setAtState(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  const reader =
    typeof r.screenReader === 'string' && READERS.has(r.screenReader)
      ? (r.screenReader as ScreenReader)
      : null
  const voice = Array.isArray(r.voiceControl)
    ? r.voiceControl.filter((v): v is string => typeof v === 'string')
    : []
  const next: AtState = { screenReader: reader, voiceControl: voice }
  const prev = state
  const changed = JSON.stringify(next) !== JSON.stringify(prev)
  state = next
  if (changed) for (const fn of listeners) fn(next, prev)
  return changed
}
