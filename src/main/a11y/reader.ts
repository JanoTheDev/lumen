// "Read the page" (06 T13): long text read aloud in parts with stop / pause / continue / next /
// back. Pure: speech, timers and the clock are injected. When Lumen's voice speaks a part, the
// voice renderer reports the end of playback (`speech.finished`) and the next part follows it;
// the estimated speaking time is the fallback. A screen reader reports nothing, so with one the
// estimate alone sets the pace.

/** About 170 spoken words a minute at rate 1. */
const WORDS_PER_MINUTE = 170
/** Gap after each part. */
const GAP_MS = 400
const MIN_PART_MS = 1200
/** Waiting for a playback report: synthesis delay and slower voices on top of the estimate. */
const FALLBACK_FACTOR = 1.5
const FALLBACK_EXTRA_MS = 3000

/**
 * Splits text into parts of at most `max` characters: paragraphs first, long paragraphs at
 * sentence ends, very long sentences at the last space. Blank lines are dropped.
 */
export function chunkText(text: string, max = 600): string[] {
  const out: string[] = []
  const paragraphs = text
    .split(/\n\s*\n|\n(?=\s*[-•*]\s)/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  for (const p of paragraphs) {
    if (p.length <= max) {
      pushOrJoin(out, p, max)
      continue
    }
    let cur = ''
    for (const s of p.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [p]) {
      const sentence = s.trim()
      if (!sentence) continue
      if (cur && cur.length + 1 + sentence.length > max) {
        out.push(cur)
        cur = ''
      }
      if (sentence.length > max) {
        for (const piece of splitAtSpaces(sentence, max)) {
          if (cur) out.push(cur)
          cur = piece
        }
        continue
      }
      cur = cur ? `${cur} ${sentence}` : sentence
    }
    if (cur) out.push(cur)
  }
  return out
}

/** Short paragraphs (headings, list items) join the part before them while it has room. */
function pushOrJoin(out: string[], p: string, max: number): void {
  const last = out[out.length - 1]
  if (last !== undefined && last.length < max / 3 && last.length + 1 + p.length <= max) {
    out[out.length - 1] = `${last}${/[.!?:]$/.test(last) ? '' : '.'} ${p}`
  } else out.push(p)
}

function splitAtSpaces(s: string, max: number): string[] {
  const parts: string[] = []
  let rest = s
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max)
    const at = cut > max / 2 ? cut : max
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Estimated time to speak `text` at `rate` (1 = normal). */
export function speakMs(text: string, rate = 1): number {
  const words = text.split(/\s+/).filter(Boolean).length
  const ms = (words / (WORDS_PER_MINUTE * Math.max(0.25, rate))) * 60_000
  return Math.max(MIN_PART_MS, Math.round(ms)) + GAP_MS
}

/** How long a part waits for its playback report before moving on anyway. */
export function fallbackMs(text: string, rate = 1): number {
  return Math.round(speakMs(text, rate) * FALLBACK_FACTOR) + FALLBACK_EXTRA_MS
}

export interface ReaderDeps {
  /**
   * Speaks one part (interrupting whatever Lumen was saying). Returns the id its playback
   * report carries (`speechFinished`), or nothing when no report will come (screen reader).
   */
  speak(text: string, index: number, total: number): string | null | void
  /** Silences Lumen's voice now. */
  silence(): void
  rate(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Reading state changed (gates, status line). */
  onChange?(state: ReaderState): void
}

export type ReaderState = 'idle' | 'reading' | 'paused'

/**
 * Whether a voice start pauses the reading. Conversation mode opens the mic again on its own
 * after each turn (hands-free); that re-listen is not the user talking, so the reading goes
 * on. A request the user then makes still ends it (query.started).
 */
export function voiceStartPausesReading(
  e: { handsFree: boolean },
  conversationActive: boolean
): boolean {
  return !(e.handsFree && conversationActive)
}

/**
 * Voice starts around a reading. An agent question re-opens the mic hands-free (ask_user): the
 * reading pauses so the mic does not take the voice for the answer, and goes on once the question
 * is settled, since an answer is used up before any request starts (no query.started). The user
 * talking (hotkey) pauses it for good, and a request ends it.
 */
export function readerVoiceHooks(
  reader: Pick<PageReader, 'pause' | 'resume' | 'status'>,
  env: { conversationActive(): boolean; askPending(): boolean }
): { voiceStarted(e: { handsFree: boolean }): void; askSettled(): void; queryStarted(): void } {
  let pausedForAsk = false
  return {
    voiceStarted(e) {
      const forAsk = e.handsFree && env.askPending()
      if (!forAsk) pausedForAsk = false
      if (!voiceStartPausesReading(e, env.conversationActive() && !forAsk)) return
      if (reader.pause() && forAsk) pausedForAsk = true
    },
    askSettled() {
      if (!pausedForAsk) return
      pausedForAsk = false
      if (reader.status === 'paused') reader.resume()
    },
    queryStarted() {
      pausedForAsk = false
    }
  }
}

export class PageReader {
  private parts: string[] = []
  private index = 0
  private timer: unknown = null
  private state: ReaderState = 'idle'
  /** Playback id of the part being spoken, while its report is awaited. */
  private waitingFor: string | null = null

  constructor(private readonly deps: ReaderDeps) {}

  get status(): ReaderState {
    return this.state
  }

  /** Reading or paused: the reading commands apply. */
  get active(): boolean {
    return this.state !== 'idle'
  }

  get position(): { index: number; total: number } {
    return { index: this.index, total: this.parts.length }
  }

  /** Starts reading `text` from the top; false when there is nothing to read. */
  start(text: string, maxPart?: number): boolean {
    this.clear()
    this.parts = chunkText(text, maxPart)
    this.index = 0
    if (!this.parts.length) {
      this.set('idle')
      return false
    }
    this.set('reading')
    this.speakCurrent()
    return true
  }

  stop(): void {
    if (this.state === 'idle') return
    this.clear()
    this.deps.silence()
    this.parts = []
    this.index = 0
    this.set('idle')
  }

  /** Stops the voice and waits; `continue` re-reads the part that was cut off. */
  pause(): boolean {
    if (this.state !== 'reading') return false
    this.clear()
    this.deps.silence()
    this.set('paused')
    return true
  }

  resume(): boolean {
    if (this.state === 'idle') return false
    this.set('reading')
    this.speakCurrent()
    return true
  }

  /** Next (+1) or previous / again (-1) part; reading continues from there. */
  skip(by: number): boolean {
    if (this.state === 'idle') return false
    const next = by < 0 ? Math.max(0, this.index - 1) : this.index + 1
    if (next >= this.parts.length) {
      this.stop()
      return false
    }
    this.index = next
    this.set('reading')
    this.speakCurrent()
    return true
  }

  /**
   * Lumen's voice finished a message: when it is the current part, the next one follows after
   * a short gap. A failed part falls back to its estimated time (the text is on the bar); a
   * stopped one keeps the fallback timer (whoever stopped it pauses or moves the reading).
   */
  speechFinished(id: string, reason: 'ended' | 'stopped' | 'failed'): void {
    if (this.state !== 'reading' || id !== this.waitingFor) return
    this.waitingFor = null
    if (reason === 'stopped') return
    this.clear()
    const text = this.parts[this.index]
    const ms = reason === 'ended' ? GAP_MS : speakMs(text, this.deps.rate())
    this.timer = this.deps.setTimeout(() => this.advance(), ms)
  }

  private speakCurrent(): void {
    this.clear()
    const text = this.parts[this.index]
    const id = this.deps.speak(text, this.index, this.parts.length)
    this.waitingFor = typeof id === 'string' ? id : null
    const rate = this.deps.rate()
    const ms = this.waitingFor ? fallbackMs(text, rate) : speakMs(text, rate)
    this.timer = this.deps.setTimeout(() => this.advance(), ms)
  }

  private advance(): void {
    this.timer = null
    if (this.state !== 'reading') return
    if (this.index + 1 >= this.parts.length) {
      this.parts = []
      this.index = 0
      this.set('idle')
      return
    }
    this.index++
    this.speakCurrent()
  }

  private clear(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer)
    this.timer = null
    this.waitingFor = null
  }

  private set(state: ReaderState): void {
    if (state === this.state) return
    this.state = state
    this.deps.onChange?.(state)
  }
}
