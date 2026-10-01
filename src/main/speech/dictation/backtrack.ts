// Course correction in dictation: "send it Tuesday, actually Wednesday" → "send it Wednesday",
// "meet at five no wait meet at six" → "meet at six", "… scratch that" drops the sentence.
// Local and pure; runs on the transcript before cleanup. A cue only counts as its own clause:
// strong cues ("no wait", "scratch that") after a comma, dash or sentence end, weak cues
// ("actually", "I mean", …) after a comma or dash with a word before them in the sentence,
// because they are also ordinary words ("delete that file", "no wait time"). Without an
// anchor word a strong cue must also be set off after it ("…, scratch that, …"). When unsure,
// the text is left as it is.

export interface Cue {
  words: readonly string[]
  strong: boolean
  /** The cue throws away the whole sentence when no anchor is found ("scratch that"). */
  dropsSentence?: boolean
  /** Only with an anchor (too common as an apology). */
  anchorOnly?: boolean
  /** Only as a sentence of its own (". Delete that."), since "…, delete that." is ordinary. */
  ownSentence?: boolean
}

export const CUES: readonly Cue[] = [
  { words: ['no', 'wait'], strong: true },
  { words: ['scratch', 'that'], strong: true, dropsSentence: true },
  { words: ['strike', 'that'], strong: true, dropsSentence: true },
  { words: ['delete', 'that'], strong: true, dropsSentence: true, ownSentence: true },
  { words: ['or', 'rather'], strong: false },
  { words: ['make', 'that'], strong: false },
  { words: ['i', 'mean'], strong: false },
  { words: ['actually'], strong: false },
  { words: ['sorry'], strong: false, anchorOnly: true }
]

/** How far back the first correction word is looked for. */
export const ANCHOR_WINDOW = 8

const norm = (w: string): string =>
  w
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')

const isDash = (w: string): boolean => /^[-–—]+$/.test(w)
const endsSentence = (w: string): boolean => /[.!?]["')\]]*$/.test(w)
const endsPause = (w: string): boolean => /[,;:\-–—]$/.test(w) || isDash(w)
const isQuestion = (w: string): boolean => /\?["')\]]*$/.test(w)

function cueAt(words: readonly string[], i: number): Cue | null {
  for (const c of CUES) {
    if (i + c.words.length > words.length) continue
    if (c.words.every((cw, k) => norm(words[i + k]) === cw)) return c
  }
  return null
}

/**
 * True when the cue at `i` stands as its own clause: never in a question ("Should I delete
 * that?"), strong cues after a pause or sentence end, weak cues after a pause mid-sentence.
 */
function standsAlone(words: readonly string[], i: number, cue: Cue, inSentence: number): boolean {
  if (isQuestion(words[i + cue.words.length - 1])) return false
  if (i === 0) return false
  const prev = words[i - 1]
  if (cue.ownSentence) return endsSentence(prev) || /[-–—]$/.test(prev)
  if (cue.strong) return endsPause(prev) || endsSentence(prev)
  return inSentence >= 1 && endsPause(prev)
}

/** The cue is also followed by a pause ("…, scratch that, call Ann"). */
function setOffAfter(words: readonly string[], i: number, cue: Cue): boolean {
  const last = words[i + cue.words.length - 1]
  return endsPause(last) || endsSentence(last)
}

/** Index of the first word of the sentence that holds word `i`. */
function sentenceStart(words: readonly string[], i: number): number {
  for (let k = i - 1; k >= 0; k--) if (endsSentence(words[k])) return k + 1
  return 0
}

/** Words of `before` without trailing dashes and pause punctuation on the last one. */
function trimTail(before: string[]): string[] {
  const out = [...before]
  while (out.length && isDash(out[out.length - 1])) out.pop()
  if (out.length) out[out.length - 1] = out[out.length - 1].replace(/[,;:\-–—]+$/, '')
  return out.filter(Boolean)
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const NUMBERS =
  /^(?:\d+(?:[.,:]\d+)*%?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)$/

/** Words that stand in for each other in a correction (a day for a day, a number for a number). */
function classOf(w: string): string | null {
  if (WEEKDAYS.includes(w)) return 'day'
  if (MONTHS.includes(w) && w !== 'may') return 'month'
  if (NUMBERS.test(w)) return 'number'
  return null
}

function lastIndex(words: readonly string[], lo: number, test: (w: string) => boolean): number {
  for (let k = words.length - 1; k >= lo; k--) if (test(norm(words[k]))) return k
  return -1
}

/** Words up to and including the first one that ends a sentence. */
function firstSentence(words: readonly string[]): string[] {
  const end = words.findIndex(endsSentence)
  return end < 0 ? [...words] : words.slice(0, end + 1)
}

export interface BacktrackResult {
  text: string
  /** Number of corrections applied. */
  applied: number
}

/** Applies every spoken self-correction it is sure about. */
export function applyBacktrack(text: string): BacktrackResult {
  let words = text.trim().split(/\s+/).filter(Boolean)
  let applied = 0
  let i = 0
  while (i < words.length) {
    const cue = cueAt(words, i)
    if (!cue) {
      i++
      continue
    }
    const start = sentenceStart(words, i)
    const before = words.slice(0, i)
    const inSentence = i - start
    if (!standsAlone(words, i, cue, inSentence)) {
      i += cue.words.length
      continue
    }
    // The cue word carries the pause ("wait," / "actually,"): it goes with the cue.
    const correction = words.slice(i + cue.words.length)
    // "It is, actually, fine": a weak cue set off by commas is a discourse word, not a fix.
    const parenthetical = !cue.strong && /,$/.test(words[i + cue.words.length - 1])
    // Without an anchor a strong cue must be set off on both sides to throw words away.
    const setOff = setOffAfter(words, i, cue)
    let next: string[] | null = null
    let resume = 0
    if (!correction.length) {
      if (cue.dropsSentence) {
        // "… scratch that" right after a sentence end drops that whole sentence.
        const from = inSentence ? start : sentenceStart(words, start - 1)
        next = words.slice(0, from)
        resume = next.length
      }
    } else {
      const first = norm(correction[0])
      const lo = Math.max(0, before.length - ANCHOR_WINDOW)
      const exact = lastIndex(before, lo, (w) => w === first)
      const cls = classOf(first)
      const similar = cls ? lastIndex(before, lo, (w) => classOf(w) === cls) : -1
      const oneWord = firstSentence(correction).length === 1
      if (exact >= 0) {
        next = [...trimTail(before.slice(0, exact)), ...correction]
      } else if (similar >= 0 && !(parenthetical && !cue.strong)) {
        // "order two pizzas, make that three" → "order three pizzas".
        next = oneWord
          ? [
              ...trimTail([
                ...before.slice(0, similar),
                correction[0],
                ...before.slice(similar + 1)
              ]),
              ...correction.slice(1)
            ]
          : [...trimTail(before.slice(0, similar)), ...correction]
      } else if (cue.dropsSentence) {
        if (setOff) next = [...before.slice(0, start), ...correction]
      } else if (!cue.anchorOnly && !parenthetical && inSentence >= 1) {
        // Only a one-word correction safely replaces the last word ("Tuesday, actually Wednesday").
        if (cue.strong ? setOff : oneWord)
          next = [...trimTail(before.slice(0, before.length - 1)), ...correction]
      }
      if (next) resume = next.length - correction.length
    }
    if (!next) {
      i += cue.words.length
      continue
    }
    words = next
    applied++
    i = Math.max(0, resume)
  }
  return { text: words.join(' '), applied }
}

/**
 * Token positions of the cues in a tokenized transcript that stand as their own clause in
 * `raw` (for the cleanup check): the n-th cue among the tokens is the n-th cue among the words.
 */
export function cueSpans(tokens: readonly string[], raw: string): { at: number; len: number }[] {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const alone: boolean[] = []
  for (let i = 0; i < words.length; i++) {
    const c = cueAt(words, i)
    if (!c) continue
    alone.push(standsAlone(words, i, c, i - sentenceStart(words, i)))
    i += c.words.length - 1
  }
  const spans: { at: number; len: number }[] = []
  let n = 0
  for (let i = 0; i < tokens.length; i++)
    for (const c of CUES)
      if (c.words.every((w, k) => tokens[i + k] === w)) {
        if (alone[n++]) spans.push({ at: i, len: c.words.length })
        i += c.words.length - 1
        break
      }
  return spans
}
