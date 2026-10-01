// Assistive tech running on this PC (agent `a11y_state`), refreshed every 60 s: the announce
// policy needs the screen reader, coexistence (T20) needs Voice Access / Dragon.

export type ScreenReader = 'nvda' | 'jaws' | 'narrator' | 'other' | null

export interface AtState {
  screenReader: ScreenReader
  voiceControl: string[]
}

const READERS = new Set(['nvda', 'jaws', 'narrator', 'other'])

let state: AtState = { screenReader: null, voiceControl: [] }

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
  const changed = JSON.stringify(next) !== JSON.stringify(state)
  state = next
  return changed
}
