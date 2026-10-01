// Announce policy (06 T03): one place that decides how a short message reaches the user.
//   screen reader running → the agent `announce` (NVDA controller); Lumen TTS stays quiet
//   no screen reader      → TTS when spoken replies are on, else visual only
// Every message is also published on the bus (a11y.announce) for the renderer's live region.
// Per-kind throttle, 3 s de-duplication, and assertive messages skip the throttle.

export type AnnounceKind = 'answer' | 'status' | 'step' | 'error' | 'confirm' | 'focus' | 'command'
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
  publish: (text: string, priority: AnnouncePriority, via: AnnounceVia) => void
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
  command: 300
}

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
    if (this.recent.has(text)) return { via: 'none', dropped: 'duplicate' }
    if (priority !== 'assertive') {
      const last = this.lastByKind.get(kind)
      if (last !== undefined && now - last < THROTTLE_MS[kind])
        return { via: 'none', dropped: 'throttled' }
    }
    this.recent.set(text, now)
    this.lastByKind.set(kind, now)

    const via = this.route()
    this.deps.publish(text, priority, via)
    if (via === 'sr') {
      this.deps
        .sendToScreenReader(text, priority)
        .then((spoken) => {
          // NVDA not reachable (Narrator, JAWS, no controller): speak it ourselves if allowed.
          if (!spoken && this.deps.ttsOn()) this.deps.speak(text)
        })
        .catch(() => {
          if (this.deps.ttsOn()) this.deps.speak(text)
        })
    } else if (via === 'tts') this.deps.speak(text)
    return { via }
  }

  route(): AnnounceVia {
    if (!this.deps.enabled()) return 'none'
    if (this.deps.screenReaderActive()) return 'sr'
    return this.deps.ttsOn() ? 'tts' : 'none'
  }

  reset(): void {
    this.lastByKind.clear()
    this.recent.clear()
  }
}
