// "Want a buddy for this?" (08 T51): after the user asks for the same kind of recurring work
// twice (a request with a recurring cue like "check my mail", "what's new", "again", "every
// morning", alike an earlier one at least a few hours before), Lumen offers once to make a
// buddy for it. The skill proposal rules apply: each pattern is offered at most once, a "no" is
// remembered, "stop offering buddies" turns it off, nothing is kept while memory is off or
// private. Requests are kept only as keyed hashes of their content words (HMAC with the skill
// proposals' per-install key), in ~/.ai-overlay/buddy-offers.json. Pure apart from the store.
import { createHmac, randomBytes } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { requestWords } from '../skills/proposals'

/** Two requests are "the same kind of work" at this word overlap. */
export const OFFER_SIMILAR_AT = 0.5
/** The earlier ask must be at least this much older (not a retry of the same ask). */
export const OFFER_GAP_MS = 4 * 60 * 60_000
/** Only asks this recent count. */
export const OFFER_WINDOW_MS = 21 * 24 * 60 * 60_000
const ASKS_MAX = 120
const PATTERNS_MAX = 200

/** Words that make a request recurring work rather than a one-off. */
const RECURRING_RE =
  /\b(?:every (?:day|morning|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|hour|month)|daily|weekly|each (?:day|morning|week)|again|check (?:my|the|for|if|whether|on)|any new|what'?s new|anything new|keep an eye|keep track|watch (?:the|my|for)|look for new|latest|news about|summari[sz]e (?:my|the|today|new)|price of|has .+ changed|tidy (?:up )?(?:my|the))\b/i

export function isRecurringAsk(prompt: string): boolean {
  return RECURRING_RE.test(prompt.replace(/[’]/g, "'"))
}

interface Ask {
  words: string[]
  at: number
}

interface Pattern {
  words: string[]
  at: number
  answer: 'offered' | 'yes' | 'no'
}

export interface BuddyOfferData {
  asks: Ask[]
  patterns: Pattern[]
  off: boolean
}

export interface BuddyOfferOptions {
  /** The per-install HMAC key; a random one when left out (tests). */
  key?: Buffer
  /** Asks may be kept (memory on, not private). */
  canRecord?: () => boolean
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0
  const sb = new Set(b)
  const inter = a.filter((x) => sb.has(x)).length
  return inter / (new Set([...a, ...b]).size || 1)
}

export interface OfferVerdict {
  /** The hashed words of this pattern (pass to `answered`). */
  words: string[]
  /** The request the buddy would be made from. */
  prompt: string
}

export class BuddyOfferStore {
  data: BuddyOfferData = { asks: [], patterns: [], off: false }
  private readonly key: Buffer

  constructor(
    private readonly file: string | null,
    private readonly opts: BuddyOfferOptions = {}
  ) {
    this.key = opts.key ?? randomBytes(32)
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuddyOfferData>
      const ok = (x: unknown): x is Ask =>
        !!x && Array.isArray((x as Ask).words) && typeof (x as Ask).at === 'number'
      this.data = {
        asks: (raw.asks ?? []).filter(ok).slice(-ASKS_MAX),
        patterns: (raw.patterns ?? []).filter(ok).slice(-PATTERNS_MAX) as Pattern[],
        off: raw.off === true
      }
    } catch {
      // Missing or broken: start empty.
    }
  }

  private hash(words: string[]): string[] {
    return words.map((w) => createHmac('sha256', this.key).update(w).digest('hex').slice(0, 12))
  }

  private mayRecord(): boolean {
    return !this.opts.canRecord || this.opts.canRecord()
  }

  /**
   * Records a finished request and says whether to offer a buddy: a recurring ask alike an
   * earlier one (≥ 4 h before, ≤ 3 weeks), never covered by a buddy or skill already, never a
   * pattern offered before, never while off.
   */
  consider(prompt: string, opts: { now: number; covered?: boolean }): OfferVerdict | null {
    if (!this.mayRecord() || !isRecurringAsk(prompt)) return null
    const words = this.hash(requestWords(prompt))
    if (words.length < 2) return null
    const earlier = this.data.asks.filter(
      (a) =>
        opts.now - a.at >= OFFER_GAP_MS &&
        opts.now - a.at <= OFFER_WINDOW_MS &&
        jaccard(words, a.words) >= OFFER_SIMILAR_AT
    ).length
    this.data.asks = [...this.data.asks, { words, at: opts.now }].slice(-ASKS_MAX)
    this.save()
    if (this.data.off || opts.covered || !earlier) return null
    if (this.data.patterns.some((p) => jaccard(words, p.words) >= OFFER_SIMILAR_AT)) return null
    return { words, prompt }
  }

  /** The offer was made or answered: this pattern is never offered again. */
  answered(words: string[], answer: Pattern['answer'], now: number): void {
    if (!this.mayRecord()) return
    const rest = this.data.patterns.filter((p) => jaccard(words, p.words) < 0.999)
    this.data.patterns = [...rest, { words, at: now, answer }].slice(-PATTERNS_MAX)
    this.save()
  }

  setOff(off: boolean): void {
    this.data.off = off
    this.save()
  }

  private save(): void {
    if (!this.file || !this.mayRecord()) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[buddies] offers not saved:', (e as Error).message)
    }
  }
}

export const OFFER_LINE =
  'You have asked for this before. Want a buddy that does it for you, on a schedule or when you call it? Say yes or no.'

const plain = (s: string): string =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** "stop offering buddies" / "start offering buddies again". */
export function matchOffersSwitch(utterance: string): 'off' | 'on' | null {
  const n = plain(utterance)
  if (/^(?:stop|dont|do not) (?:offering|suggesting|asking about) buddies$/.test(n)) return 'off'
  if (/^(?:start|resume) (?:offering|suggesting) buddies(?: again)?$/.test(n)) return 'on'
  return null
}
