// Spaced repetition (plans 07 T29): one SM-2 card per completed lesson. Quality comes from how
// the run went: 5 = no hints, 4 = a hint or two, 3 = more hints, 2 = "do it for me" or a skipped
// step. Dates are local calendar days (YYYY-MM-DD). Pure: no Electron, no fs.
import type { StepStats } from './state'

export interface SrsCard {
  /** Easiness factor, starts at 2.5, never below 1.3. */
  ef: number
  /** Days until the next review. */
  interval: number
  /** Successful reviews in a row. */
  reps: number
  /** Local day the card is due, YYYY-MM-DD. */
  due: string
  /** When the card was last reviewed (epoch ms). */
  last?: number
}

export const START_EF = 2.5
export const MIN_EF = 1.3

/** SM-2 quality (0-5) of one lesson run from its step stats. */
export function runQuality(stats: Record<string, StepStats>): number {
  const all = Object.values(stats)
  if (all.some((s) => s.doItForMe || s.skipped)) return 2
  const hints = all.reduce((n, s) => n + s.hints, 0)
  if (hints === 0) return 5
  return hints <= 2 ? 4 : 3
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day of `ms`, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `day` plus `n` calendar days (DST-safe: noon-anchored). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localDay(new Date(y, m - 1, d + n, 12).getTime())
}

/**
 * One SM-2 step. q < 3 restarts the repetitions (interval 1) and keeps the easiness factor;
 * otherwise the interval goes 1, 6, then the previous interval × EF, and the EF moves by
 * 0.1 - (5 - q)(0.08 + (5 - q) 0.02).
 */
export function sm2(card: SrsCard | undefined, quality: number, now: number): SrsCard {
  const q = Math.max(0, Math.min(5, Math.round(quality)))
  const prev = card ?? { ef: START_EF, interval: 0, reps: 0, due: localDay(now) }
  let { ef, interval, reps } = prev
  if (q < 3) {
    reps = 0
    interval = 1
  } else {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef)
    reps += 1
    ef = Math.max(MIN_EF, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  }
  ef = Math.round(ef * 1000) / 1000
  return { ef, interval, reps, due: addDays(localDay(now), interval), last: now }
}

export function isDue(card: SrsCard, today: string): boolean {
  return card.due <= today
}

export function isCard(v: unknown): v is SrsCard {
  const c = v as SrsCard
  return (
    !!c &&
    typeof c.ef === 'number' &&
    typeof c.interval === 'number' &&
    typeof c.reps === 'number' &&
    typeof c.due === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.due)
  )
}
