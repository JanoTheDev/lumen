// Settings → Usage (05 T44): the page's report, drill-down rows, per-task / per-automation cost
// and the CSV export, built from ledger lines. Pure over the rows; `usageReport` and friends read
// the ledger. Claude Code lines (paid through the user's own login or key) stay in their own
// group and never count toward Lumen's spend.
import type {
  UsageBucket,
  UsageCallRow,
  UsageCalls,
  UsageCallsFilter,
  UsageCost,
  UsageDayBar,
  UsageGroup,
  UsageRange,
  UsageReport,
  UsageSums,
  UsageTableRow
} from '@shared/usage'
import { USAGE_BUCKETS, USAGE_GROUPS } from '@shared/usage'
import { csvField } from '../docs-out/text'
import { dayKey, isExternal, queryUsage, startOfDay, startOfMonth, type UsageRow } from './ledger'
import type { UsageOrigin } from './scope'

export const TOP_N = 20
export const MAX_CALLS = 500
/** How far back a task's or automation's cost is looked up. */
export const TASK_LOOKBACK_DAYS = 90

/** Display names for ids; each one optional (a missing lookup shows the id). */
export interface UsageNames {
  automation?: (id: string) => string | undefined
  task?: (id: string) => string | undefined
  buddy?: (id: string) => string | undefined
  skill?: (id: string) => string | undefined
}

const DAY_MS = 86_400_000

export function rangeBounds(range: UsageRange, now = Date.now()): { from: number; to: number } {
  const today = startOfDay(new Date(now))
  const back = (days: number): number =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - days).getTime()
  const from =
    range === 'today'
      ? today.getTime()
      : range === '7d'
        ? back(6)
        : range === '30d'
          ? back(29)
          : startOfMonth(today).getTime()
  return { from, to: now + 1 }
}

const BUCKET: Record<UsageOrigin, UsageBucket> = {
  'user-direct': 'you',
  dictation: 'you',
  lesson: 'you',
  agent: 'tasks',
  subagent: 'tasks',
  background: 'background',
  routine: 'automations',
  automation: 'automations',
  buddy: 'buddies',
  'claude-code-copilot': 'other',
  system: 'other'
}

export const bucketOf = (origin: string): UsageBucket => BUCKET[origin as UsageOrigin] ?? 'other'

export const emptySums = (): UsageSums => ({
  calls: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
  audioSec: 0,
  usd: 0,
  unpriced: 0,
  free: 0
})

const NANO = 1_000_000_000
const roundUsd = (n: number): number => Math.round(n * NANO) / NANO

function add(s: UsageSums, r: UsageRow): void {
  const n = r.calls ?? 1
  s.calls += n
  s.in += r.in
  s.out += r.out
  s.cacheRead += r.cacheRead
  s.cacheWrite += r.cacheWrite
  s.searches += r.searches
  s.audioSec += r.audioSec
  s.usd = roundUsd(s.usd + r.usd)
  if (!r.priced) s.unpriced += n
  if (r.free) s.free += n
}

/** Lumen's own lines (default) or only the Claude Code ones. */
export function sumRows(rows: readonly UsageRow[], external = false): UsageSums {
  const s = emptySums()
  for (const r of rows) if (isExternal(r) === external) add(s, r)
  return s
}

export const tokensOf = (s: Pick<UsageSums, 'in' | 'out' | 'cacheRead' | 'cacheWrite'>): number =>
  s.in + s.out + s.cacheRead + s.cacheWrite

/** Cache reads over all input tokens (fresh + cache read + cache write). */
export function cacheHitRate(s: UsageSums): number | null {
  const input = s.in + s.cacheRead + s.cacheWrite
  return input > 0 ? s.cacheRead / input : null
}

/** A task's helpers count toward it: a spawned child carries its parent as parentTaskId. */
export const rootTask = (r: UsageRow): string | undefined => r.parentTaskId ?? r.taskId

function groupKey(r: UsageRow, group: UsageGroup): string | undefined {
  switch (group) {
    case 'feature':
      return r.feature
    case 'automation':
      return r.automationId
    case 'buddy':
      return r.buddyId
    case 'skill':
      return r.skillId
    case 'task':
      return rootTask(r)
    case 'model':
      return `${r.provider}/${r.model}`
  }
}

function nameFor(group: UsageGroup, key: string, names: UsageNames): string {
  const look =
    group === 'automation'
      ? names.automation
      : group === 'task'
        ? names.task
        : group === 'buddy'
          ? names.buddy
          : group === 'skill'
            ? names.skill
            : undefined
  let name: string | undefined
  try {
    name = look?.(key)
  } catch {
    name = undefined
  }
  return name?.trim() || key
}

const bySpend = (a: UsageTableRow, b: UsageTableRow): number =>
  b.sums.usd - a.sums.usd || tokensOf(b.sums) - tokensOf(a.sums) || b.sums.calls - a.sums.calls

function table(
  rows: readonly UsageRow[],
  keyOf: (r: UsageRow) => string | undefined,
  name: (key: string) => string,
  external = false
): UsageTableRow[] {
  const groups = new Map<string, UsageSums>()
  for (const r of rows) {
    if (isExternal(r) !== external) continue
    const k = keyOf(r)
    if (!k) continue
    const s = groups.get(k) ?? emptySums()
    add(s, r)
    groups.set(k, s)
  }
  return [...groups]
    .map(([key, sums]) => ({ key, name: name(key), sums }))
    .sort(bySpend)
    .slice(0, TOP_N)
}

const zeroBuckets = (): Record<UsageBucket, number> =>
  Object.fromEntries(USAGE_BUCKETS.map((b) => [b, 0])) as Record<UsageBucket, number>

/** One bar per local day from `from` to `to`, Lumen's lines only. */
export function dayBars(rows: readonly UsageRow[], from: number, to: number): UsageDayBar[] {
  const bars = new Map<string, UsageDayBar>()
  const start = startOfDay(new Date(from))
  for (let d = new Date(start); d.getTime() < to; d.setDate(d.getDate() + 1)) {
    const day = dayKey(d)
    bars.set(day, { day, usd: zeroBuckets(), tokens: zeroBuckets() })
    if (bars.size > 400) break
  }
  for (const r of rows) {
    if (isExternal(r)) continue
    const bar = bars.get(dayKey(r.t))
    if (!bar) continue
    const b = bucketOf(r.origin)
    bar.usd[b] = roundUsd(bar.usd[b] + r.usd)
    bar.tokens[b] += r.in + r.out + r.cacheRead + r.cacheWrite
  }
  return [...bars.values()]
}

/** The page's whole report from the lines of the range. */
export function buildReport(
  rows: readonly UsageRow[],
  range: UsageRange,
  bounds: { from: number; to: number },
  names: UsageNames = {}
): UsageReport {
  const sums = sumRows(rows)
  const tables = Object.fromEntries(
    USAGE_GROUPS.map((g) => [
      g,
      table(
        rows,
        (r) => groupKey(r, g),
        (k) => nameFor(g, k, names)
      )
    ])
  ) as Record<UsageGroup, UsageTableRow[]>
  const cc = sumRows(rows, true)
  return {
    range,
    from: bounds.from,
    to: bounds.to,
    sums,
    cacheHitRate: cacheHitRate(sums),
    days: dayBars(rows, bounds.from, bounds.to),
    tables,
    claudeCode: cc.calls
      ? {
          sums: cc,
          sessions: table(
            rows,
            (r) => r.ccSession ?? 'unknown',
            (k) => k,
            true
          )
        }
      : null
  }
}

/** Does a line belong to a drill-down row? */
export function inFilter(r: UsageRow, f: UsageCallsFilter): boolean {
  if (f.group === 'claude') return isExternal(r) && (r.ccSession ?? 'unknown') === f.key
  if (isExternal(r)) return false
  if (f.group === 'bucket') return bucketOf(r.origin) === f.key
  if (f.group === 'day') return dayKey(r.t) === f.key
  return groupKey(r, f.group) === f.key
}

function callRow(r: UsageRow): UsageCallRow {
  const row: UsageCallRow = {
    t: r.t,
    provider: r.provider,
    model: r.model,
    origin: r.origin,
    feature: r.feature,
    in: r.in,
    out: r.out,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    searches: r.searches,
    audioSec: r.audioSec,
    usd: r.usd,
    priced: r.priced,
    free: r.free,
    calls: r.calls ?? 1
  }
  if (r.taskId) row.taskId = r.taskId
  return row
}

/** Matching lines, newest first, at most 500. */
export function callsFor(rows: readonly UsageRow[], f: UsageCallsFilter): UsageCalls {
  const hit = rows.filter((r) => inFilter(r, f))
  const rowsOut: UsageCallRow[] = []
  for (let i = hit.length - 1; i >= 0 && rowsOut.length < MAX_CALLS; i--)
    rowsOut.push(callRow(hit[i]))
  return { rows: rowsOut, total: hit.length }
}

function cost(s: UsageSums): UsageCost {
  return { usd: s.usd, tokens: tokensOf(s), calls: s.calls, unpriced: s.unpriced }
}

/** Each task's spend with its helpers (child tasks and sub-agent jobs). */
export function taskCosts(
  rows: readonly UsageRow[],
  ids: readonly string[]
): Record<string, UsageCost> {
  const want = new Set(ids)
  const sums = new Map<string, UsageSums>()
  for (const r of rows) {
    if (isExternal(r)) continue
    const keys = new Set([r.taskId, r.parentTaskId].filter((k): k is string => !!k && want.has(k)))
    for (const k of keys) {
      const s = sums.get(k) ?? emptySums()
      add(s, r)
      sums.set(k, s)
    }
  }
  const out: Record<string, UsageCost> = {}
  for (const [k, s] of sums) out[k] = cost(s)
  return out
}

/** Spend per automation id. */
export function automationCosts(rows: readonly UsageRow[]): Record<string, UsageCost> {
  const sums = new Map<string, UsageSums>()
  for (const r of rows) {
    if (isExternal(r) || !r.automationId) continue
    const s = sums.get(r.automationId) ?? emptySums()
    add(s, r)
    sums.set(r.automationId, s)
  }
  const out: Record<string, UsageCost> = {}
  for (const [k, s] of sums) out[k] = cost(s)
  return out
}

export const CSV_COLUMNS = [
  'time',
  'provider',
  'model',
  'role',
  'origin',
  'feature',
  'billing',
  'calls',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'searches',
  'audio_seconds',
  'usd',
  'priced',
  'free',
  'task_id',
  'parent_task_id',
  'automation_id',
  'buddy_id',
  'skill_id',
  'claude_session'
] as const

/**
 * One line per call, counts and ids only (never names or text), formula-looking cells as text,
 * with a BOM so Excel reads it as UTF-8.
 */
export function usageCsv(rows: readonly UsageRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of rows) {
    const cells = [
      new Date(r.t).toISOString(),
      r.provider,
      r.model,
      r.role ?? '',
      r.origin,
      r.feature,
      r.billing ?? 'lumen',
      String(r.calls ?? 1),
      String(r.in),
      String(r.out),
      String(r.cacheRead),
      String(r.cacheWrite),
      String(r.searches),
      String(r.audioSec),
      String(r.usd),
      r.priced ? 'yes' : 'no',
      r.free ? 'yes' : 'no',
      r.taskId ?? '',
      r.parentTaskId ?? '',
      r.automationId ?? '',
      r.buddyId ?? '',
      r.skillId ?? '',
      r.ccSession ?? ''
    ]
    lines.push(cells.map((c) => csvField(c)).join(','))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}

// ---- ledger readers ----

export function usageReport(
  range: UsageRange,
  names: UsageNames = {},
  now = Date.now()
): UsageReport {
  const bounds = rangeBounds(range, now)
  return buildReport(queryUsage(bounds), range, bounds, names)
}

export function usageCalls(range: UsageRange, f: UsageCallsFilter, now = Date.now()): UsageCalls {
  return callsFor(queryUsage(rangeBounds(range, now)), f)
}

export function usageCsvFor(range: UsageRange, now = Date.now()): string {
  return usageCsv(queryUsage(rangeBounds(range, now)))
}

export function usageForTasks(ids: readonly string[], now = Date.now()): Record<string, UsageCost> {
  if (!ids.length) return {}
  return taskCosts(queryUsage({ from: now - TASK_LOOKBACK_DAYS * DAY_MS, to: now + 1 }), ids)
}

/** This month's spend per automation. */
export function usageByAutomation(now = Date.now()): Record<string, UsageCost> {
  return automationCosts(queryUsage({ from: startOfMonth(new Date(now)), to: now + 1 }))
}
