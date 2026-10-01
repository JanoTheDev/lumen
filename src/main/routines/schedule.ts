// Routine schedules (cron-lite): daily at HH:MM on some weekdays, or every N minutes (N ≥ 15).
// Local time. Also the spoken form: "every weekday at 9 summarize my unread mail".
import type { RoutineSchedule } from '@shared/routines'

export const MIN_EVERY_MINUTES = 15
export const MAX_EVERY_MINUTES = 24 * 60
const DAY_MS = 86_400_000

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function validSchedule(s: RoutineSchedule): boolean {
  if (s.kind === 'every')
    return (
      Number.isInteger(s.minutes) &&
      s.minutes >= MIN_EVERY_MINUTES &&
      s.minutes <= MAX_EVERY_MINUTES
    )
  if (!TIME_RE.test(s.at)) return false
  return !s.days || s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
}

/** The first run strictly after `after` (ms epoch). `every` counts from `after`. */
export function nextRun(s: RoutineSchedule, after: number): number {
  if (s.kind === 'every') return after + s.minutes * 60_000
  const [h, m] = s.at.split(':').map(Number)
  const days = s.days?.length ? new Set(s.days) : null
  const d = new Date(after)
  d.setHours(h, m, 0, 0)
  for (let i = 0; i < 9; i++) {
    if (d.getTime() > after && (!days || days.has(d.getDay()))) return d.getTime()
    // setDate keeps the wall-clock time across DST changes.
    d.setDate(d.getDate() + 1)
    d.setHours(h, m, 0, 0)
  }
  return after + DAY_MS
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function describeSchedule(s: RoutineSchedule): string {
  if (s.kind === 'every') {
    if (s.minutes % 60 === 0) {
      const h = s.minutes / 60
      return h === 1 ? 'every hour' : `every ${h} hours`
    }
    return `every ${s.minutes} minutes`
  }
  const days = [...new Set(s.days ?? [])].sort()
  let when: string
  if (!days.length || days.length === 7) when = 'every day'
  else if (days.join() === '1,2,3,4,5') when = 'every weekday'
  else if (days.join() === '0,6') when = 'every weekend day'
  else when = `every ${days.map((d) => DAY_NAMES[d]).join(', ')}`
  return `${when} at ${s.at}`
}

// ---- spoken form ----

const NUMBER_WORDS: Record<string, number> = {
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
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'forty five': 45,
  'forty-five': 45,
  sixty: 60,
  ninety: 90
}

export const DAY_WORDS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

export function num(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word)
  return NUMBER_WORDS[word] ?? null
}

export const NUM = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[ -]five|sixty|ninety)`
const DAY = String.raw`(?:sun|mon|tues|wednes|thurs|fri|satur)days?`
const PERIOD = String.raw`(?:weekdays?|week ?days?|weekends?|days?|mornings?|evenings?|nights?|${DAY}(?:(?:,| and|, and) ${DAY})*)`
export const TIME = String.raw`(?:at |@ ?)?(noon|midnight|\d{1,2}(?:[:.]\d{2})?(?: ?[ap]\.?m\.?)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: o'?clock)?(?: ?(?:in the )?(morning|evening|at night|afternoon))?`

const EVERY_N_RE = new RegExp(
  String.raw`^(?:every|each) (?:(half an hour|half hour)|(?:${NUM} )?(minutes?|mins?|hours?))\b`
)
const DAILY_RE = new RegExp(String.raw`^(?:(?:every|each|on) (${PERIOD})|(daily))(?: ${TIME})?\b`)

/** "9", "9:30 pm", "noon", "seven" + an optional "in the evening" → "HH:MM" or null. */
export function parseTime(raw: string, partOfDay?: string): string | null {
  const t = raw.toLowerCase().replace(/\./g, (_m, i: number, s: string) => {
    // "9.30" keeps its separator; "p.m." loses its dots.
    return /\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? '') ? ':' : ''
  })
  if (t === 'noon') return '12:00'
  if (t === 'midnight') return '00:00'
  const m = /^(\d{1,2}|[a-z]+)(?::(\d{2}))?(?: ?([ap])m)?$/.exec(t.replace(/\s+/g, ' ').trim())
  if (!m) return null
  let h = num(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (h === null || h > 23 || min > 59) return null
  const pm = m[3] === 'p' || (!m[3] && /evening|night|afternoon/.test(partOfDay ?? '') && h < 12)
  if (m[3] && h > 12) return null
  if (pm && h < 12) h += 12
  if (m[3] === 'a' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function periodDays(period: string): { days?: number[]; defaultAt: string } {
  const p = period.toLowerCase()
  if (/^week ?days?$/.test(p)) return { days: [1, 2, 3, 4, 5], defaultAt: '09:00' }
  if (/^weekends?$/.test(p)) return { days: [0, 6], defaultAt: '10:00' }
  if (/^mornings?$/.test(p)) return { defaultAt: '08:00' }
  if (/^evenings?$/.test(p)) return { defaultAt: '18:00' }
  if (/^nights?$/.test(p)) return { defaultAt: '21:00' }
  if (/^days?$/.test(p)) return { defaultAt: '09:00' }
  const days = [...p.matchAll(/(sun|mon|tues|wednes|thurs|fri|satur)days?/g)].map(
    (x) => DAY_WORDS[`${x[1]}day`]
  )
  return { days: [...new Set(days)].sort(), defaultAt: '09:00' }
}

export type ParsedRoutine =
  | { ok: true; schedule: RoutineSchedule; prompt: string; usedDefaultTime: boolean }
  | { ok: false; reason: string }

const ROUTINE_PREFIX_RE =
  /^(?:please )?(?:create|add|make|set up|setup|start|new) (?:a |me a )?(?:new )?routine(?: that| which| to)?[:,]? */

export const NOT_A_TASK_RE =
  /^(?:i|i'm|im|my|me|it|it's|its|is|are|was|were|the|a|an|we|you|he|she|they|this|that|there|our|your|his|her|their|does|do|did|should|would|can|could|will|how|what|why|when|where|who|which|so|and|but|or|of|in|on|for)\b/

export function cleanPrompt(p: string): string {
  return p
    .replace(/^[\s,:;–—-]+/, '')
    .replace(/^(?:then|please|i want you to|can you|could you)\s+/i, '')
    .replace(/[\s,]+$/, '')
    .trim()
}

export function leading(
  text: string
): { schedule: RoutineSchedule; rest: string; def: boolean } | null {
  const e = EVERY_N_RE.exec(text)
  if (e) {
    let minutes: number
    if (e[1]) minutes = 30
    else {
      const n = e[2] ? num(e[2].replace('-', ' ')) : 1
      if (n === null) return null
      minutes = /^h/.test(e[3]) ? n * 60 : n
    }
    return { schedule: { kind: 'every', minutes }, rest: text.slice(e[0].length), def: false }
  }
  const d = DAILY_RE.exec(text)
  if (!d) return null
  const { days, defaultAt } = d[2] ? { days: undefined, defaultAt: '09:00' } : periodDays(d[1])
  const part = d[4] ?? (d[1] && /morning|evening|night/.test(d[1]) ? d[1] : undefined)
  const at = d[3] ? parseTime(d[3], part) : defaultAt
  if (!at) return null
  return {
    schedule: { kind: 'daily', at, ...(days?.length ? { days } : {}) },
    rest: text.slice(d[0].length),
    def: !d[3]
  }
}

/**
 * A spoken routine: "every weekday at 9 summarize my unread mail", "every 30 minutes check
 * the lamp price", or "create a routine to back up my notes every day at 6 pm".
 * null = not a routine request.
 */
export function parseRoutineUtterance(utterance: string): ParsedRoutine | null {
  let text = utterance
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const prefixed = ROUTINE_PREFIX_RE.exec(text)
  if (prefixed) text = text.slice(prefixed[0].length)
  let found = leading(text)
  let prompt = found ? cleanPrompt(found.rest) : ''
  if (!found && prefixed) {
    // "create a routine to <prompt> every weekday at 9": the schedule at the end.
    const at = text.search(/\b(?:every|each|daily|on (?:week|mon|tue|wed|thu|fri|sat|sun))\b/)
    if (at > 0) {
      const tail = leading(text.slice(at))
      if (tail && !cleanPrompt(tail.rest)) {
        found = tail
        prompt = cleanPrompt(text.slice(0, at))
      }
    }
  }
  if (!found)
    return prefixed
      ? { ok: false, reason: 'When should it run? For example “every weekday at 9”.' }
      : null
  if (!prefixed) {
    // Without "create a routine", only an imperative after an explicit schedule counts:
    // "every day is a gift" or "every 15 minutes my PC freezes" stay ordinary questions.
    const vague = found.def && /^(?:(?:every|each|on) days?|daily)\b/.test(text)
    if (vague || NOT_A_TASK_RE.test(prompt)) return null
  }
  if (!prompt || prompt.split(' ').length < 2)
    return prefixed
      ? { ok: false, reason: 'What should the routine do? Say the schedule, then the task.' }
      : null
  const s = found.schedule
  if (s.kind === 'every' && s.minutes < MIN_EVERY_MINUTES)
    return { ok: false, reason: `Routines run at most every ${MIN_EVERY_MINUTES} minutes.` }
  if (!validSchedule(s)) return { ok: false, reason: 'I could not understand that schedule.' }
  // Restore the user's own casing for the prompt.
  const idx = utterance.toLowerCase().indexOf(prompt)
  const original = idx >= 0 ? utterance.slice(idx, idx + prompt.length) : prompt
  return { ok: true, schedule: s, prompt: original, usedDefaultTime: found.def }
}
