// Settings → Usage (05 T44): the report the page shows, drill-down call rows, per-task and
// per-automation cost. Built in main from the usage ledger; counts only, never text.

export type UsageRange = 'today' | '7d' | '30d' | 'month'

export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'month']

/** Tables on the page; `model` is provider/model. */
export type UsageGroup = 'feature' | 'automation' | 'buddy' | 'skill' | 'task' | 'model'

export const USAGE_GROUPS: readonly UsageGroup[] = [
  'feature',
  'automation',
  'buddy',
  'skill',
  'task',
  'model'
]

/** The chart's origin buckets, in fixed colour order. */
export type UsageBucket = 'you' | 'tasks' | 'background' | 'automations' | 'buddies' | 'other'

export const USAGE_BUCKETS: readonly UsageBucket[] = [
  'you',
  'tasks',
  'background',
  'automations',
  'buddies',
  'other'
]

export interface UsageSums {
  calls: number
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  searches: number
  audioSec: number
  usd: number
  /** Calls whose price is not known (their cost counts as $0). */
  unpriced: number
  /** Local model or free-tier calls ($0 by design). */
  free: number
}

export interface UsageTableRow {
  key: string
  /** Display name (automation / task / buddy name, else the id). */
  name: string
  sums: UsageSums
}

export interface UsageDayBar {
  /** YYYY-MM-DD, local. */
  day: string
  usd: Record<UsageBucket, number>
  tokens: Record<UsageBucket, number>
}

export interface UsageReport {
  range: UsageRange
  from: number
  to: number
  sums: UsageSums
  /** Cache reads / all input tokens; null without input tokens. */
  cacheHitRate: number | null
  /** One bar per day in the range, oldest first. */
  days: UsageDayBar[]
  /** Top 20 per group, biggest spend first. */
  tables: Record<UsageGroup, UsageTableRow[]>
  /** Paid through the user's own Claude Code login / key, never in Lumen's spend. */
  claudeCode: { sums: UsageSums; sessions: UsageTableRow[] } | null
}

/** Which rows a drill-down shows. `claude` = one Claude Code session. */
export interface UsageCallsFilter {
  group: UsageGroup | 'bucket' | 'day' | 'claude'
  key: string
}

export interface UsageCallRow {
  t: number
  provider: string
  model: string
  origin: string
  feature: string
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  searches: number
  audioSec: number
  usd: number
  priced: boolean
  free: boolean
  calls: number
  taskId?: string
}

export interface UsageCalls {
  rows: UsageCallRow[]
  /** Matching calls before the 500-row cap. */
  total: number
}

/** A task's (and its helpers') or an automation's spend. */
export interface UsageCost {
  usd: number
  tokens: number
  calls: number
  unpriced: number
}

/** Monthly limits (05 T45): one scope's spend this month against its cap. */
export interface UsageLimitRow {
  kind: 'overall' | 'automation' | 'buddy'
  /** '' for overall. */
  id: string
  name: string
  usd: number
  /** Input + output tokens. */
  tokens: number
  capUsd?: number
  capTokens?: number
  /** Highest share of a cap used (0 without a cap). */
  ratio: number
  level: 'none' | 'ok' | 'warn' | 'paused'
  /** Calls with no known price, counted in `usd` at a standard rate. */
  estimated?: number
}

export interface UsageLimitsView {
  overall: UsageLimitRow
  automations: UsageLimitRow[]
  /** Read-only here; the buddy's page edits its budget. */
  buddies: UsageLimitRow[]
}
