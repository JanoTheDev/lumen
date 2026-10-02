// The Models & keys cost card (`usage:get`): today, the last 30 days and a per-day estimate,
// computed from the usage ledger (usage/ledger, 05 T43). Lumen's own spend only: Claude Code
// lines are paid by the user's Claude login and never counted here.
import {
  dayKey,
  enableLedger,
  flushLedger,
  pruneLedger,
  queryUsage,
  startOfDay
} from '../usage/ledger'
import { migrateOldUsage } from '../usage/migrate'
import { roundUsd } from './pricing'
import type { UsageDay as DayUsage, UsageOverview as UsageSummary } from '@shared/channels'

export type { DayUsage, UsageSummary }

const KEEP_DAYS = 30

/** Turns on the ledger files (app start): imports the old usage.json once, prunes old months. */
export function enableUsageLog(): void {
  enableLedger()
  migrateOldUsage()
  pruneLedger()
}

export const dateKey = (now: Date): string => dayKey(now)

/** Writes pending ledger lines now. Never throws. */
export function flushUsage(): void {
  flushLedger()
}

const empty = (date: string): DayUsage => ({
  date,
  usd: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
})

/** `estimated`: some call this session used a model without a known price. */
export function usageSummary(
  sessionUsd: number,
  now = new Date(),
  estimated = false
): UsageSummary {
  const from = startOfDay(now)
  from.setDate(from.getDate() - (KEEP_DAYS - 1))
  const byDay = new Map<string, DayUsage>()
  for (const r of queryUsage({ from, to: now.getTime() + 1 })) {
    if (r.billing) continue
    const key = dayKey(r.t)
    const d = byDay.get(key) ?? empty(key)
    byDay.set(key, {
      date: key,
      usd: roundUsd(d.usd + r.usd),
      calls: d.calls + (r.calls ?? 1),
      inputTokens: d.inputTokens + r.in,
      outputTokens: d.outputTokens + r.out,
      cacheReadTokens: d.cacheReadTokens + r.cacheRead,
      cacheWriteTokens: d.cacheWriteTokens + r.cacheWrite
    })
  }
  const today = byDay.get(dayKey(now)) ?? empty(dayKey(now))
  const list = [...byDay.values()]
    .filter((d) => d.calls > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const recent = list.filter((d) => d.date >= dayKey(weekAgo))
  const perDay = recent.length
    ? roundUsd(recent.reduce((sum, d) => sum + d.usd, 0) / recent.length)
    : 0
  return {
    today,
    sessionUsd,
    days: list,
    estimatePerDay: perDay,
    estimatePerMonth: roundUsd(perDay * 30),
    estimated
  }
}
