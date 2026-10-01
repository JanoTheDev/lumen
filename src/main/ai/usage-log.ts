// Daily model usage on disk (~/.ai-overlay/usage.json, last 30 days) for the Settings cost
// estimate. Totals only: no prompts, no models' replies.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { configPath } from '../config'
import { roundUsd } from './pricing'
import type { UsageDay as DayUsage, UsageOverview as UsageSummary } from '@shared/channels'
import type { Usage } from './providers/types'

export type { DayUsage, UsageSummary }

const KEEP_DAYS = 30
const SAVE_DELAY_MS = 1000

interface UsageFile {
  version: 1
  days: DayUsage[]
}

let days: Map<string, DayUsage> | null = null
let saveTimer: NodeJS.Timeout | null = null
let pathOverride: string | null = null
// Off until the app enables it, so tests and scripts never write into the real home folder.
let persist = false

/** Turns on reading and writing usage.json (app start). */
export function enableUsageLog(): void {
  persist = true
  days = null
}

export function usagePath(): string {
  return pathOverride ?? join(dirname(configPath()), 'usage.json')
}

export function dateKey(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
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

function load(): Map<string, DayUsage> {
  if (days) return days
  days = new Map()
  if (!persist) return days
  try {
    if (existsSync(usagePath())) {
      const file = JSON.parse(readFileSync(usagePath(), 'utf8')) as UsageFile
      for (const d of Array.isArray(file.days) ? file.days : []) {
        if (typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
          days.set(d.date, { ...empty(d.date), ...d })
      }
    }
  } catch (e) {
    console.warn(`[cost] usage.json unreadable, starting fresh: ${(e as Error).message}`)
  }
  return days
}

function prune(map: Map<string, DayUsage>, now: Date): void {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - (KEEP_DAYS - 1))
  const min = dateKey(cutoff)
  for (const key of map.keys()) if (key < min) map.delete(key)
}

/** Writes the file now (also cancels a pending delayed write). Never throws. */
export function flushUsage(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!days || !persist) return
  try {
    const path = usagePath()
    mkdirSync(dirname(path), { recursive: true })
    const file: UsageFile = {
      version: 1,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
    }
    // Write-then-rename so a crash mid-write never leaves a half file.
    writeFileSync(`${path}.tmp`, JSON.stringify(file, null, 1), 'utf8')
    renameSync(`${path}.tmp`, path)
  } catch (e) {
    console.warn(`[cost] usage.json not saved: ${(e as Error).message}`)
  }
}

let unpriced = false

/** Adds one call to its day; the file is written a second later (or on flushUsage). */
export function addDayUsage(usd: number, usage: Usage, known: boolean, now = new Date()): void {
  const map = load()
  const key = dateKey(now)
  const d = map.get(key) ?? empty(key)
  map.set(key, {
    ...d,
    usd: roundUsd(d.usd + usd),
    calls: d.calls + 1,
    inputTokens: d.inputTokens + usage.inputTokens,
    outputTokens: d.outputTokens + usage.outputTokens,
    cacheReadTokens: d.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens + usage.cacheWriteTokens
  })
  if (!known) unpriced = true
  prune(map, now)
  if (persist && !saveTimer) {
    saveTimer = setTimeout(flushUsage, SAVE_DELAY_MS)
    saveTimer.unref?.()
  }
}

export function usageSummary(sessionUsd: number, now = new Date()): UsageSummary {
  const map = load()
  prune(map, now)
  const today = map.get(dateKey(now)) ?? empty(dateKey(now))
  const list = [...map.values()]
    .filter((d) => d.calls > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const recent = list.filter((d) => d.date >= dateKey(weekAgo))
  const perDay = recent.length
    ? roundUsd(recent.reduce((sum, d) => sum + d.usd, 0) / recent.length)
    : 0
  return {
    today,
    sessionUsd,
    days: list,
    estimatePerDay: perDay,
    estimatePerMonth: roundUsd(perDay * 30),
    estimated: unpriced
  }
}

/** Test hook: use another file (persisting to it), or null to go back to memory only. */
export function setUsagePath(path: string | null): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  pathOverride = path
  persist = path !== null
  days = null
  unpriced = false
}
