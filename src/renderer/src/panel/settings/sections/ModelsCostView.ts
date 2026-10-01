// Settings → Models & keys → Cost: plain lines from the usage log (usage:get). Pure.
import type { UsageDay, UsageOverview } from '@shared/channels'

/** "$0.42", "under $0.01", "$0". */
export function usd(n: number): string {
  if (n <= 0) return '$0'
  if (n < 0.01) return 'under $0.01'
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}

const calls = (n: number): string => `${n} ${n === 1 ? 'request' : 'requests'}`

export interface CostView {
  /** The headline: rough cost per day and per month, or that there's no data yet. */
  estimate: string
  today: string
  /** Last 7 days with use, newest first: [label, cost]. */
  recent: Array<[string, string]>
  note?: string
}

export function costView(u: UsageOverview, now = new Date()): CostView {
  const estimate =
    u.days.length === 0
      ? 'No model use yet, so no estimate.'
      : `About ${usd(u.estimatePerDay)} a day (${usd(u.estimatePerMonth)} a month) at your recent use.`
  const recent = u.days
    .slice(-7)
    .reverse()
    .map((d: UsageDay): [string, string] => [
      dayLabel(d.date, now),
      `${usd(d.usd)} · ${calls(d.calls)}`
    ])
  return {
    estimate,
    today: `Today ${usd(u.today.usd)} (${calls(u.today.calls)}), since Lumen started ${usd(u.sessionUsd)}.`,
    recent,
    note: u.estimated
      ? 'Some models have no known price; they are counted at a mid-range rate.'
      : undefined
  }
}

function dayLabel(date: string, now: Date): string {
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (date === key(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (date === key(y)) return 'Yesterday'
  const [yy, mm, dd] = date.split('-').map(Number)
  return new Date(yy, mm - 1, dd).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}
