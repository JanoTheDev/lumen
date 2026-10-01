// Announce policy (06 T03): one place that decides how a short message reaches the user.
//   screen reader running → the agent `announce` (NVDA controller); Lumen TTS stays quiet
//   no screen reader      → TTS when spoken replies are on, else visual only
// Every message is also published on the bus (a11y.announce) with who voiced it, so the
// assistant bar can show (and, when nobody spoke it, announce) it.
// Per-kind throttle, 3 s de-duplication, and assertive messages skip the throttle.
// `phase` (assistant phase changes) goes to a screen reader only, never to Lumen's TTS.

export type AnnounceKind =
  | 'answer'
  | 'status'
  | 'step'
  | 'error'
  | 'confirm'
  | 'focus'
  | 'command'
  /** Switch scanning item names: every move is spoken, repeats included. */
  | 'scan'
  /** Assistant phase changes ("Thinking"): screen reader or shown, never TTS. */
  | 'phase'
export type AnnouncePriority = 'polite' | 'assertive'
export type AnnounceVia = 'sr' | 'tts' | 'none'

export interface AnnounceOptions {
  priority?: AnnouncePriority
  kind?: AnnounceKind
}

export interface AnnounceDeps {
  now: () => number
  /** a11y.announce config: "off" mutes everything but the bus. */
  enabled: () => boolean
  screenReaderActive: () => boolean
  ttsOn: () => boolean
  /** Agent announce; resolves false when the screen reader did not take it (no NVDA etc.). */
  sendToScreenReader: (text: string, priority: AnnouncePriority) => Promise<boolean>
  speak: (text: string) => void
  publish: (text: string, priority: AnnouncePriority, via: AnnounceVia, kind: AnnounceKind) => void
  /** The screen reader did not take it and TTS is off: nobody heard it after all. */
  unspoken?: (text: string, priority: AnnouncePriority, kind: AnnounceKind) => void
}

/** Minimum gap between two messages of the same kind. */
export const THROTTLE_MS: Record<AnnounceKind, number> = {
  answer: 0,
  status: 1500,
  step: 0,
  error: 0,
  confirm: 0,
  // FocusNarrator already waits for focus to settle.
  focus: 200,
  command: 300,
  scan: 0,
  phase: 1500
}

/** Kinds Lumen's own voice never speaks (a screen reader still gets them). */
const NOT_SPOKEN: ReadonlySet<AnnounceKind> = new Set(['phase'])

export const DEDUPE_MS = 3000
const MAX_TEXT = 1000

export interface AnnounceResult {
  via: AnnounceVia
  dropped?: 'empty' | 'duplicate' | 'throttled'
}

export class Announcer {
  private lastByKind = new Map<AnnounceKind, number>()
  private recent = new Map<string, number>()

  constructor(private readonly deps: AnnounceDeps) {}

  /** Synchronous routing decision; the screen reader send itself is fire-and-forget. */
  announce(raw: string, opts: AnnounceOptions = {}): AnnounceResult {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    if (!text) return { via: 'none', dropped: 'empty' }
    const kind = opts.kind ?? 'status'
    const priority = opts.priority ?? (kind === 'error' ? 'assertive' : 'polite')
    const now = this.deps.now()

    for (const [t, at] of this.recent) if (now - at > DEDUPE_MS) this.recent.delete(t)
    // Scanning comes back to the same item every pass; that is not a duplicate.
    if (kind !== 'scan' && this.recent.has(text)) return { via: 'none', dropped: 'duplicate' }
    if (priority !== 'assertive') {
      const last = this.lastByKind.get(kind)
      if (last !== undefined && now - last < THROTTLE_MS[kind])
        return { via: 'none', dropped: 'throttled' }
    }
    if (kind !== 'scan') this.recent.set(text, now)
    this.lastByKind.set(kind, now)

    const via = this.route(kind)
    this.deps.publish(text, priority, via, kind)
    if (via === 'sr') {
      const fallback = (): void => {
        // No screen reader took it (secure desktop, controller gone): speak it ourselves if
        // allowed, else the bar announces it.
        if (this.deps.ttsOn() && !NOT_SPOKEN.has(kind)) this.deps.speak(text)
        else this.deps.unspoken?.(text, priority, kind)
      }
      this.deps
        .sendToScreenReader(text, priority)
        .then((spoken) => {
          if (!spoken) fallback()
        })
        .catch(fallback)
    } else if (via === 'tts') this.deps.speak(text)
    return { via }
  }

  route(kind: AnnounceKind = 'status'): AnnounceVia {
    if (!this.deps.enabled()) return 'none'
    if (this.deps.screenReaderActive()) return 'sr'
    return this.deps.ttsOn() && !NOT_SPOKEN.has(kind) ? 'tts' : 'none'
  }

  reset(): void {
    this.lastByKind.clear()
    this.recent.clear()
  }
}
