// Automation triggers: validation, the next time a time trigger fires (local wall-clock time, so
// a run at 09:00 stays at 09:00 across DST changes) and plain-language descriptions.
import type {
  AutomationAction,
  AutomationTrigger,
  EventTrigger,
  TimeTrigger
} from '@shared/automations'
import { describeSchedule, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, nextRun } from './schedule'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
export const MAX_IDLE_MINUTES = 12 * 60
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isTimeTrigger(t: AutomationTrigger): t is TimeTrigger {
  return t.kind === 'daily' || t.kind === 'every' || t.kind === 'monthly' || t.kind === 'once'
}

export function isEventTrigger(t: AutomationTrigger): t is EventTrigger {
  return !isTimeTrigger(t)
}

const hm = (s: string): [number, number] => s.split(':').map(Number) as [number, number]
const validDays = (days?: number[]): boolean =>
  !days || days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)

export function validTrigger(t: AutomationTrigger): boolean {
  switch (t.kind) {
    case 'daily':
      return TIME_RE.test(t.at) && validDays(t.days)
    case 'every': {
      if (!Number.isInteger(t.minutes) || t.minutes < MIN_EVERY_MINUTES) return false
      if (t.minutes > MAX_EVERY_MINUTES || !validDays(t.days)) return false
      if (t.from === undefined && t.to === undefined) return !t.days?.length
      return !!t.from && !!t.to && TIME_RE.test(t.from) && TIME_RE.test(t.to) && t.from < t.to
    }
    case 'monthly':
      return Number.isInteger(t.day) && t.day >= 1 && t.day <= 31 && TIME_RE.test(t.at)
    case 'once':
      return Number.isFinite(t.at) && t.at > 0
    case 'startup':
    case 'online':
      return true
    case 'app':
      return typeof t.app === 'string' && t.app.trim().length >= 2 && t.app.length <= 60
    case 'file':
      return (
        typeof t.folder === 'string' &&
        t.folder.length > 2 &&
        t.folder.length <= 260 &&
        (t.pattern === undefined || /^[\p{L}\p{N}*?._ -]{1,40}$/u.test(t.pattern))
      )
    case 'idle':
      return Number.isInteger(t.minutes) && t.minutes >= 1 && t.minutes <= MAX_IDLE_MINUTES
    default:
      return false
  }
}

/** "every hour between 9 and 5": from, from + N, … ≤ to on the allowed days. */
function nextInWindow(t: Extract<TimeTrigger, { kind: 'every' }>, after: number): number | null {
  const [fh, fm] = hm(t.from!)
  const [th, tm] = hm(t.to!)
  const days = t.days?.length ? new Set(t.days) : null
  const base = new Date(after)
  for (let i = 0; i < 9; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
    if (days && !days.has(day.getDay())) continue
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), th, tm).getTime()
    for (let k = 0; ; k++) {
      // Minutes past `from` in wall-clock terms (setHours normalizes the overflow).
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), fh, fm + k * t.minutes)
      const ms = at.getTime()
      if (ms > end) break
      if (ms > after) return ms
    }
  }
  return null
}

function nextMonthly(t: Extract<TimeTrigger, { kind: 'monthly' }>, after: number): number {
  const [h, m] = hm(t.at)
  const a = new Date(after)
  for (let i = 0; i < 14; i++) {
    const last = new Date(a.getFullYear(), a.getMonth() + i + 1, 0).getDate()
    const at = new Date(a.getFullYear(), a.getMonth() + i, Math.min(t.day, last), h, m).getTime()
    if (at > after) return at
  }
  return after + 31 * 86_400_000
}

/**
 * The first time a time trigger fires strictly after `after` (ms epoch); null for event
 * triggers and for a one-off whose time has passed. Plain "every N minutes" counts from `after`.
 */
export function nextFire(t: AutomationTrigger, after: number): number | null {
  switch (t.kind) {
    case 'daily':
      return nextRun(t, after)
    case 'every':
      return t.from && t.to
        ? nextInWindow(t, after)
        : nextRun({ kind: 'every', minutes: t.minutes }, after)
    case 'monthly':
      return nextMonthly(t, after)
    case 'once':
      return t.at > after ? t.at : null
    default:
      return null
  }
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

function daysText(days?: number[]): string {
  const d = [...new Set(days ?? [])].sort()
  if (!d.length || d.length === 7) return ''
  if (d.join() === '1,2,3,4,5') return ' on weekdays'
  if (d.join() === '0,6') return ' on weekends'
  return ` on ${d.map((x) => DAY_NAMES[x]).join(', ')}`
}

function fileWhat(pattern?: string): string {
  const ext = /^\*\.([a-z0-9]{1,8})$/i.exec(pattern ?? '')
  if (ext) return `a ${ext[1].toUpperCase()} file`
  return pattern && pattern !== '*' ? `a file named ${pattern}` : 'a file'
}

export function folderName(folder: string): string {
  return (
    folder
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || folder
  )
}

export function describeTrigger(t: AutomationTrigger): string {
  switch (t.kind) {
    case 'daily':
      return describeSchedule(t)
    case 'every': {
      const base = describeSchedule({ kind: 'every', minutes: t.minutes })
      return t.from && t.to ? `${base} between ${t.from} and ${t.to}${daysText(t.days)}` : base
    }
    case 'monthly':
      return `every month on the ${ordinal(t.day)} at ${t.at}`
    case 'once': {
      const d = new Date(t.at)
      return `once, on ${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} at ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    case 'startup':
      return 'when Lumen starts'
    case 'app':
      return t.on === 'open' ? `when ${t.app} opens` : `when ${t.app} closes`
    case 'file':
      return t.on === 'added'
        ? `when ${fileWhat(t.pattern)} is added to ${folderName(t.folder)}`
        : `when ${fileWhat(t.pattern)} changes in ${folderName(t.folder)}`
    case 'idle':
      return t.on === 'idle'
        ? `after ${t.minutes} minutes without input`
        : `when you are back after ${t.minutes} minutes away`
    case 'online':
      return 'when the internet comes back'
  }
}

export function describeAction(a: AutomationAction): string {
  if (a.kind === 'remind') return `remind you: “${a.say}”`
  if (a.kind === 'skill') return `run the skill “${a.skill}”${a.prompt ? ` (${a.prompt})` : ''}`
  return `run “${a.prompt}” in the background`
}

/** "Every weekday at 09:00, run “…” in the background." */
export function describeAutomation(t: AutomationTrigger, a: AutomationAction): string {
  const when = describeTrigger(t)
  const line = `${when.charAt(0).toUpperCase()}${when.slice(1)}, ${describeAction(a)}`
  return /[.!?]”?$/.test(line) ? line : `${line}.`
}
