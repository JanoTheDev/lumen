// Spoken numbers for grammar slots: digits, "five", "twenty one", "one hundred and two",
// ordinals ("third"). Homophones (to/too/for/won/ate) count only when the caller allows them.

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
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

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
}

export const HOMOPHONES: Record<string, number> = {
  to: 2,
  too: 2,
  for: 4,
  fore: 4,
  won: 1,
  ate: 8,
  free: 3,
  tree: 3
}

const unitWords = Object.keys(UNITS).join('|')
const tensWords = Object.keys(TENS).join('|')
const ordinalWords = Object.keys(ORDINALS).join('|')
const homophoneWords = Object.keys(HOMOPHONES).join('|')

// "one hundred and twenty one", "twenty one", "seven", "42", "3rd", "third".
const BELOW_100 = `(?:(?:${tensWords})(?: (?:${unitWords}))?|${unitWords})`
export const NUMBER_SOURCE = [
  `\\d{1,3}(?:st|nd|rd|th)?`,
  `(?:${unitWords}) hundred(?: and)?(?: ${BELOW_100})?`,
  BELOW_100,
  ordinalWords
].join('|')

/** Regex source for a number slot, homophones included (the parser decides if they count). */
export const NUMBER_SLOT = `(?:${NUMBER_SOURCE}|${homophoneWords})`

export interface ParsedNumber {
  value: number
  homophone: boolean
}

/** Parses one number slot's text; null when it is not a number. */
export function parseNumber(text: string): ParsedNumber | null {
  const t = text.trim()
  if (!t) return null
  if (t in HOMOPHONES) return { value: HOMOPHONES[t], homophone: true }
  const digits = /^(\d{1,3})(?:st|nd|rd|th)?$/.exec(t)
  if (digits) return { value: Number(digits[1]), homophone: false }
  if (t in ORDINALS) return { value: ORDINALS[t], homophone: false }
  const words = t.split(' ').filter((w) => w !== 'and')
  let total = 0
  let current = 0
  for (const w of words) {
    if (w in UNITS) current += UNITS[w]
    else if (w in TENS) current += TENS[w]
    else if (w === 'hundred') current = (current || 1) * 100
    else return null
  }
  total += current
  return { value: total, homophone: false }
}
