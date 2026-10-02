// Settings → Usage (05 T44): pure helpers for the page (money and token text, table sorting,
// the per-day stacked bars' geometry, the one-line cost used on task and automation rows).
import type {
  UsageBucket,
  UsageCost,
  UsageDayBar,
  UsageGroup,
  UsageRange,
  UsageSums,
  UsageTableRow
} from '@shared/usage'
import { USAGE_BUCKETS } from '@shared/usage'

export const RANGE_LABEL: Record<UsageRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  month: 'This month'
}

export const GROUP_LABEL: Record<UsageGroup, string> = {
  feature: 'Feature',
  automation: 'Automation',
  buddy: 'Buddy',
  skill: 'Skill',
  task: 'Task',
  model: 'Model'
}

export const BUCKET_LABEL: Record<UsageBucket, string> = {
  you: 'You',
  tasks: 'Agent tasks',
  background: 'Background',
  automations: 'Automations',
  buddies: 'Buddies',
  other: 'Other'
}

/** "$0", "<$0.01", "$0.42", "$12.30", "$140". */
export function money(n: number): string {
  if (n <= 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n)}`
}

/** "950", "12.3k", "1.2M". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export const sumTokens = (s: Pick<UsageSums, 'in' | 'out' | 'cacheRead' | 'cacheWrite'>): number =>
  s.in + s.out + s.cacheRead + s.cacheWrite

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** "$0.03 · 12k tokens" for a task or automation; '' without calls. */
export function costLine(c: UsageCost | undefined): string {
  if (!c || !c.calls) return ''
  const parts = [money(c.usd), `${tokens(c.tokens)} tokens`]
  if (c.unpriced) parts.push('some calls have no price')
  return parts.join(' · ')
}

export type SortKey = 'name' | 'calls' | 'tokens' | 'usd'

export function sortRows(
  rows: readonly UsageTableRow[],
  key: SortKey,
  dir: 'asc' | 'desc'
): UsageTableRow[] {
  const val = (r: UsageTableRow): number | string =>
    key === 'name'
      ? r.name.toLowerCase()
      : key === 'calls'
        ? r.sums.calls
        : key === 'tokens'
          ? sumTokens(r.sums)
          : r.sums.usd
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    return (x < y ? -1 : x > y ? 1 : 0) * sign
  })
}

/** Lines under the totals: unpriced calls, local / free calls. */
export function notes(s: UsageSums): string[] {
  const out: string[] = []
  if (s.unpriced)
    out.push(
      `${s.unpriced} ${s.unpriced === 1 ? 'call' : 'calls'} used a model without a known price; ${s.unpriced === 1 ? 'it counts' : 'they count'} as $0 here.`
    )
  if (s.free)
    out.push(
      `${s.free} ${s.free === 1 ? 'call' : 'calls'} ran on a local model or a free tier ($0).`
    )
  return out
}

export type ChartMetric = 'usd' | 'tokens'

export interface BarSegment {
  bucket: UsageBucket
  y: number
  h: number
  value: number
}

export interface Bar {
  day: string
  /** "Oct 2". */
  label: string
  x: number
  total: number
  segments: BarSegment[]
}

export interface ChartGeometry {
  bars: Bar[]
  max: number
  barWidth: number
  /** Buckets with any value in the range, in fixed colour order. */
  buckets: UsageBucket[]
}

const GAP = 2

export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Stacked bars inside width × height; segments bottom-up in bucket order, 2 px gaps. */
export function chartGeometry(
  days: readonly UsageDayBar[],
  metric: ChartMetric,
  width: number,
  height: number
): ChartGeometry {
  const totals = days.map((d) => USAGE_BUCKETS.reduce((a, b) => a + d[metric][b], 0))
  const max = Math.max(0, ...totals)
  const slot = days.length ? width / days.length : width
  const barWidth = Math.max(2, Math.min(28, slot - Math.max(2, slot * 0.3)))
  const used = new Set<UsageBucket>()
  const bars = days.map((d, i) => {
    let top = height
    const segments: BarSegment[] = []
    for (const b of USAGE_BUCKETS) {
      const value = d[metric][b]
      if (value <= 0 || max <= 0) continue
      used.add(b)
      const full = (value / max) * height
      const h = Math.max(1, full - (segments.length ? GAP : 0))
      top -= full
      segments.push({ bucket: b, y: top, h, value })
    }
    return {
      day: d.day,
      label: dayLabel(d.day),
      x: i * slot + (slot - barWidth) / 2,
      total: totals[i],
      segments
    }
  })
  return { bars, max, barWidth, buckets: USAGE_BUCKETS.filter((b) => used.has(b)) }
}

export function metricText(metric: ChartMetric, n: number): string {
  return metric === 'usd' ? money(n) : `${tokens(n)} tokens`
}

/** The chart's text equivalent for screen readers. */
export function chartSummary(g: ChartGeometry, metric: ChartMetric): string {
  if (!g.max) return 'No use in this range.'
  const top = g.bars.reduce((a, b) => (b.total > a.total ? b : a))
  return `Per day by who asked. Highest: ${top.label}, ${metricText(metric, top.total)}.`
}
