// Spoken English numbers → digits for dictation formatting (04 T35). Pure. "twenty five
// dollars" → "$25", "three point five" → "3.5", "march third" → "March 3", "three thirty pm"
// → "3:30 pm". Small numbers in prose stay words ("one of them", "first, …") so lists and
// ordinary sentences read the same.

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
}
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 }
const ORD_UNITS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19
}
const ORD_TENS: Record<string, number> = {
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90
}

export const MONTHS = [
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

const NUMBER_WORDS = [
  ...Object.keys(UNITS),
  ...Object.keys(TENS),
  'hundred',
  ...Object.keys(SCALES),
  ...Object.keys(ORD_UNITS),
  ...Object.keys(ORD_TENS),
  'hundredth',
  'thousandth'
].sort((a, b) => b.length - a.length)
const W = NUMBER_WORDS.join('|')
/** A run of number words joined by spaces, hyphens, "and" or a decimal "point". */
const RUN_RE = new RegExp(
  `\\b(?:${W})(?:(?:[ \\t]+|-|[ \\t]+and[ \\t]+|[ \\t]+point[ \\t]+)(?:${W}))*\\b`,
  'gi'
)

type Kind = 'unit' | 'teen' | 'ten' | 'hundred' | 'scale'

export interface NumberGroup {
  value: number
  ordinal: boolean
  /** Digits after a spoken "point". */
  decimals: string
  /** Character range inside the run. */
  start: number
  end: number
}

interface Tok {
  w: string
  start: number
  end: number
}

/** Splits a run of number words into the numbers it says ("three thirty" → 3, 30). */
export function parseRun(run: string): NumberGroup[] {
  const toks: Tok[] = [...run.matchAll(/[A-Za-z]+/g)].map((m) => ({
    w: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length
  }))
  const out: NumberGroup[] = []
  let i = 0
  while (i < toks.length) {
    let total = 0
    let cur = 0
    let last: Kind | null = null
    let lastScale = Infinity
    let ordinal = false
    let decimals = ''
    const start = toks[i].start
    let end = toks[i].start
    let j = i
    for (; j < toks.length && !ordinal; j++) {
      const w = toks[j].w
      if (w === 'and') {
        if ((last === 'hundred' || last === 'scale') && j + 1 < toks.length) continue
        break
      }
      if (w === 'point') {
        // Decimal digits: "three point one four".
        let k = j + 1
        let digits = ''
        while (k < toks.length && toks[k].w in UNITS && UNITS[toks[k].w] < 10)
          digits += String(UNITS[toks[k++].w])
        if (!digits || last === null) break
        decimals = digits
        end = toks[k - 1].end
        j = k
        break
      }
      const u = UNITS[w] ?? ORD_UNITS[w]
      const t = TENS[w] ?? ORD_TENS[w]
      const isOrd = w in ORD_UNITS || w in ORD_TENS || w === 'hundredth' || w === 'thousandth'
      if (u !== undefined) {
        const ok =
          last === null ||
          last === 'hundred' ||
          last === 'scale' ||
          (last === 'ten' && u < 10 && u > 0)
        if (!ok) break
        cur += u
        last = u < 10 ? 'unit' : 'teen'
      } else if (t !== undefined) {
        if (!(last === null || last === 'hundred' || last === 'scale')) break
        cur += t
        last = 'ten'
      } else if (w === 'hundred' || w === 'hundredth') {
        if (!(last === 'unit' || last === 'teen' || last === 'ten') || !cur || cur >= 100) break
        cur *= 100
        last = 'hundred'
      } else {
        const s = SCALES[w] ?? (w === 'thousandth' ? 1e3 : undefined)
        if (s === undefined || last === null || last === 'scale' || s >= lastScale) break
        total += cur * s
        cur = 0
        lastScale = s
        last = 'scale'
      }
      if (isOrd) ordinal = true
      end = toks[j].end
    }
    if (j === i) {
      // A word that cannot start a number here (a bare "hundred"): skip it.
      i++
      continue
    }
    // A trailing "and" was not part of the number.
    while (j > i && toks[j - 1].w === 'and') j--
    out.push({ value: total + cur, ordinal, decimals, start, end })
    i = j
  }
  return out
}

const CURRENCY: Record<string, (n: string) => string> = {
  dollar: (n) => `$${n}`,
  dollars: (n) => `$${n}`,
  bucks: (n) => `$${n}`,
  euro: (n) => `€${n}`,
  euros: (n) => `€${n}`,
  pound: (n) => `£${n}`,
  pounds: (n) => `£${n}`,
  percent: (n) => `${n}%`
}

function digits(v: number, decimals: string): string {
  const whole = v >= 10_000 ? v.toLocaleString('en-US') : String(v)
  return decimals ? `${whole}.${decimals}` : whole
}

function ordinalSuffix(v: number): string {
  const t = v % 100
  if (t >= 11 && t <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][v % 10] ?? 'th'
}

const prevWord = (s: string, at: number): string =>
  (/([A-Za-z]+)[^A-Za-z]*$/.exec(s.slice(0, at))?.[1] ?? '').toLowerCase()

/** Spoken numbers in `text` written as digits where that reads better. */
export function formatNumbers(text: string): string {
  return text
    .replace(RUN_RE, (run: string, offset: number, all: string) => {
      const groups = parseRun(run)
      if (!groups.length) return run
      const after = all.slice(offset + run.length)
      const prev = prevWord(all, offset)
      const next = /^[ \t]*([A-Za-z.']+)/.exec(after)?.[1].toLowerCase() ?? ''
      const clock = /^(?:a\.?m\.?|p\.?m\.?|o'clock)$/.test(next)
      // "three thirty pm" / "at three thirty": a time.
      if (groups.length === 2 && !groups[0].ordinal && !groups[1].ordinal) {
        const [h, m] = groups
        if (
          h.value >= 1 &&
          h.value <= 12 &&
          m.value >= 10 &&
          m.value < 60 &&
          !h.decimals &&
          !m.decimals
        )
          if (clock || prev === 'at') return `${h.value}:${m.value}`
      }
      // Several numbers in a row ("one two three") stay as said.
      if (groups.length > 1) return run
      const g = groups[0]
      const n = digits(g.value, g.decimals)
      if (g.ordinal) {
        if (MONTHS.includes(prev) && g.value >= 1 && g.value <= 31) return String(g.value)
        return g.value >= 10 ? `${g.value}${ordinalSuffix(g.value)}` : run
      }
      if (CURRENCY[next] || clock || g.decimals || g.value >= 10) return n
      if (MONTHS.includes(prev) && prev !== 'may' && g.value >= 1) return n
      return run
    })
    .replace(
      /(\$|€|£)?(\d[\d,.]*)[ \t]+(dollars?|bucks|euros?|pounds?|percent)\b/gi,
      (_m, sym: string | undefined, num: string, unit: string) =>
        sym ? `${sym}${num} ${unit}` : CURRENCY[unit.toLowerCase()](num)
    )
}

/**
 * Every spoken number as plain digits, for the format check: "twenty first" and "21st" both
 * become "21", "two thousand five hundred" and "2,500" both "2500".
 */
export function numbersToDigits(text: string): string {
  return text
    .replace(RUN_RE, (run: string) =>
      parseRun(run)
        .map((g) => (g.decimals ? `${g.value} ${g.decimals}` : String(g.value)))
        .join(' ')
    )
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')
}
