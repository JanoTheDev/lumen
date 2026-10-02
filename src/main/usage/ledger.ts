// Usage ledger (05 T43): one NDJSON line per model / paid search / cloud speech call in
// ~/.ai-overlay/usage/YYYY-MM.ndjson, with who caused it (the usage scope). Counts only: never a
// prompt, a reply or a transcript. Writes are batched (1 s) and flushed on quit; month files
// older than 13 months are removed. Still recorded in private mode (there is no text in it).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { configPath } from '../config'
import { currentUsageScope, type UsageOrigin, type UsageScope } from './scope'

export interface UsageRow {
  /** Epoch ms. */
  t: number
  provider: string
  model: string
  /** Model role (main, fast, …) when the call came through a role. */
  role?: string
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  searches: number
  audioSec: number
  /** Characters sent to a cloud voice. */
  chars?: number
  usd: number
  /** False: the model's price is not known (usd counts it as $0). */
  priced: boolean
  /** Local model or free tier. */
  free: boolean
  origin: UsageOrigin
  feature: string
  taskId?: string
  parentTaskId?: string
  automationId?: string
  buddyId?: string
  skillId?: string
  ccSession?: string
  /**
   * Paid elsewhere, never part of Lumen's spend: 'claude-code' = the user's Claude Code login or
   * key (tokens and cost from its stream-json `result` events).
   */
  billing?: 'claude-code'
  /** Calls this line stands for (migrated daily totals); 1 when absent. */
  calls?: number
}

/** What a call site knows; the scope fills origin, feature and the ids. */
export type UsageEntry = Partial<Omit<UsageRow, 't' | 'provider' | 'model'>> & {
  provider: string
  model: string
  t?: number
}

export interface UsageTotals {
  calls: number
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  searches: number
  audioSec: number
  usd: number
  /** Calls whose price is not known (their tokens count, their cost does not). */
  unpriced: number
}

export type UsageFilter = Partial<
  Pick<
    UsageRow,
    | 'origin'
    | 'feature'
    | 'taskId'
    | 'parentTaskId'
    | 'automationId'
    | 'buddyId'
    | 'skillId'
    | 'ccSession'
    | 'provider'
    | 'model'
    | 'role'
  >
>

const FLUSH_MS = 1000
const KEEP_MONTHS = 13

let dirOverride: string | null = null
// Off until the app enables it, so tests and scripts never write into the real home folder.
let persist = false
const months = new Map<string, UsageRow[]>()
const pending = new Map<string, UsageRow[]>()
let timer: NodeJS.Timeout | null = null
const listeners = new Set<(row: UsageRow) => void>()

export function ledgerDir(): string {
  return dirOverride ?? join(dirname(configPath()), 'usage')
}

export function ledgerPersisting(): boolean {
  return persist
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local month key, YYYY-MM. */
export function monthKey(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

/** Local day key, YYYY-MM-DD. */
export function dayKey(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d
  return `${monthKey(date)}-${pad(date.getDate())}`
}

const fileFor = (month: string): string => join(ledgerDir(), `${month}.ndjson`)

function parseLine(line: string): UsageRow | null {
  if (!line.trim()) return null
  try {
    const r = JSON.parse(line) as UsageRow
    return typeof r?.t === 'number' && typeof r.model === 'string' ? r : null
  } catch {
    return null // a half-written last line after a crash
  }
}

function load(month: string): UsageRow[] {
  const cached = months.get(month)
  if (cached) return cached
  const rows: UsageRow[] = []
  if (persist) {
    try {
      const path = fileFor(month)
      if (existsSync(path))
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          const r = parseLine(line)
          if (r) rows.push(r)
        }
    } catch (e) {
      console.warn(`[usage] ${month} unreadable: ${(e as Error).message}`)
    }
  }
  months.set(month, rows)
  return rows
}

function clean(row: UsageRow): UsageRow {
  const out = { ...row } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k]
  return out as unknown as UsageRow
}

/** Builds the line from the entry plus the current usage scope. */
export function buildRow(entry: UsageEntry, scope: UsageScope = currentUsageScope()): UsageRow {
  return clean({
    t: entry.t ?? Date.now(),
    provider: entry.provider,
    model: entry.model,
    role: entry.role,
    in: entry.in ?? 0,
    out: entry.out ?? 0,
    cacheRead: entry.cacheRead ?? 0,
    cacheWrite: entry.cacheWrite ?? 0,
    searches: entry.searches ?? 0,
    audioSec: entry.audioSec ?? 0,
    chars: entry.chars,
    usd: entry.usd ?? 0,
    priced: entry.priced ?? true,
    free: entry.free ?? false,
    origin: entry.origin ?? scope.origin,
    feature: entry.feature ?? scope.feature ?? 'other',
    taskId: entry.taskId ?? scope.taskId,
    parentTaskId: entry.parentTaskId ?? scope.parentTaskId,
    automationId: entry.automationId ?? scope.automationId,
    buddyId: entry.buddyId ?? scope.buddyId,
    skillId: entry.skillId ?? scope.skillId,
    ccSession: entry.ccSession ?? scope.ccSession,
    billing: entry.billing,
    calls: entry.calls
  })
}

/** Records one call (the line is written within a second, or on flushLedger). */
export function recordCall(entry: UsageEntry): UsageRow {
  const row = buildRow(entry)
  addRow(row)
  return row
}

function addRow(row: UsageRow): void {
  const month = monthKey(row.t)
  load(month).push(row)
  for (const fn of listeners) {
    try {
      fn(row)
    } catch (e) {
      console.warn(`[usage] listener failed: ${(e as Error).message}`)
    }
  }
  if (!persist) return
  const list = pending.get(month) ?? []
  list.push(row)
  pending.set(month, list)
  if (!timer) {
    timer = setTimeout(flushLedger, FLUSH_MS)
    timer.unref?.()
  }
}

/** Each recorded line (limits and live views). Returns the unsubscribe. */
export function onUsageRecorded(fn: (row: UsageRow) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Writes pending lines now. Never throws. */
export function flushLedger(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!persist || !pending.size) return
  try {
    mkdirSync(ledgerDir(), { recursive: true })
  } catch (e) {
    console.warn(`[usage] folder not made: ${(e as Error).message}`)
    return
  }
  for (const [month, rows] of pending) {
    try {
      appendFileSync(fileFor(month), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      pending.delete(month)
    } catch (e) {
      console.warn(`[usage] ${month} not saved: ${(e as Error).message}`)
    }
  }
}

/** Month keys on disk (and in memory), oldest first. */
export function ledgerMonths(): string[] {
  const keys = new Set(months.keys())
  if (persist) {
    try {
      for (const f of readdirSync(ledgerDir())) {
        const m = /^(\d{4}-\d{2})\.ndjson$/.exec(f)
        if (m) keys.add(m[1])
      }
    } catch {
      // no folder yet
    }
  }
  return [...keys].sort()
}

/** Removes month files older than 13 months (this one included). */
export function pruneLedger(now = new Date()): void {
  const cutoff = monthKey(new Date(now.getFullYear(), now.getMonth() - (KEEP_MONTHS - 1), 1))
  for (const month of ledgerMonths()) {
    if (month >= cutoff) continue
    months.delete(month)
    pending.delete(month)
    if (persist) {
      try {
        rmSync(fileFor(month), { force: true })
      } catch (e) {
        console.warn(`[usage] ${month} not removed: ${(e as Error).message}`)
      }
    }
  }
}

/** Writes lines straight to their month files (migration); skips the batch. */
export function importRows(rows: UsageRow[]): void {
  for (const row of rows) {
    const month = monthKey(row.t)
    load(month).push(row)
    if (!persist) continue
    mkdirSync(ledgerDir(), { recursive: true })
    appendFileSync(fileFor(month), JSON.stringify(row) + '\n', 'utf8')
  }
}

export interface UsageQuery {
  /** Epoch ms or Date, inclusive. Default: start of this month. */
  from?: number | Date
  /** Epoch ms or Date, exclusive. Default: now + 1 ms. */
  to?: number | Date
  filter?: UsageFilter
}

const ms = (d: number | Date): number => (typeof d === 'number' ? d : d.getTime())

export function matches(row: UsageRow, filter: UsageFilter = {}): boolean {
  for (const [k, v] of Object.entries(filter))
    if (v !== undefined && row[k as keyof UsageRow] !== v) return false
  return true
}

/** Lines between `from` and `to` that match the filter, oldest first. */
export function queryUsage(q: UsageQuery = {}): UsageRow[] {
  const now = Date.now()
  const from = q.from !== undefined ? ms(q.from) : startOfMonth(new Date(now)).getTime()
  const to = q.to !== undefined ? ms(q.to) : now + 1
  const out: UsageRow[] = []
  const first = monthKey(from)
  const last = monthKey(Math.max(from, to - 1))
  for (const month of ledgerMonths()) {
    if (month < first || month > last) continue
    for (const r of load(month)) if (r.t >= from && r.t < to && matches(r, q.filter)) out.push(r)
  }
  return out.sort((a, b) => a.t - b.t)
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Claude Code lines and other spend that is not Lumen's own. */
export const isExternal = (r: UsageRow): boolean => r.billing !== undefined

export const emptyTotals = (): UsageTotals => ({
  calls: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
  audioSec: 0,
  usd: 0,
  unpriced: 0
})

const NANO = 1_000_000_000
export const roundUsd = (n: number): number => Math.round(n * NANO) / NANO

/**
 * Sums lines. By default only Lumen's own spend; `{external: true}` sums only the lines paid
 * elsewhere (Claude Code), so the two never mix.
 */
export function totals(rows: UsageRow[], opts: { external?: boolean } = {}): UsageTotals {
  const t = emptyTotals()
  for (const r of rows) {
    if (isExternal(r) !== !!opts.external) continue
    const n = r.calls ?? 1
    t.calls += n
    t.in += r.in
    t.out += r.out
    t.cacheRead += r.cacheRead
    t.cacheWrite += r.cacheWrite
    t.searches += r.searches
    t.audioSec += r.audioSec
    t.usd = roundUsd(t.usd + r.usd)
    if (!r.priced) t.unpriced += n
  }
  return t
}

export type UsageGroupKey = keyof UsageFilter | 'day' | 'month' | 'providerModel'

function keyOf(r: UsageRow, key: UsageGroupKey): string | undefined {
  if (key === 'day') return dayKey(r.t)
  if (key === 'month') return monthKey(r.t)
  if (key === 'providerModel') return `${r.provider}/${r.model}`
  const v = r[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * Totals per value of `key` (lines without it are left out), biggest spend first, then most
 * tokens. Same external rule as `totals`.
 */
export function sumBy(
  rows: UsageRow[],
  key: UsageGroupKey,
  opts: { external?: boolean } = {}
): Array<{ key: string; totals: UsageTotals }> {
  const groups = new Map<string, UsageRow[]>()
  for (const r of rows) {
    const k = keyOf(r, key)
    if (k === undefined) continue
    const list = groups.get(k) ?? []
    list.push(r)
    groups.set(k, list)
  }
  return [...groups]
    .map(([k, list]) => ({ key: k, totals: totals(list, opts) }))
    .filter((g) => g.totals.calls > 0)
    .sort(
      (a, b) =>
        b.totals.usd - a.totals.usd ||
        b.totals.in + b.totals.out - (a.totals.in + a.totals.out) ||
        a.key.localeCompare(b.key)
    )
}

/** This month's Lumen spend for a scope, e.g. `{buddyId}` or `{automationId}` (limits). */
export function monthTotals(filter: UsageFilter = {}, now = new Date()): UsageTotals {
  return totals(queryUsage({ from: startOfMonth(now), to: now.getTime() + 1, filter }))
}

/** Turns on reading and writing the month files (app start). */
export function enableLedger(): void {
  persist = true
  months.clear()
  pending.clear()
}

/** Test hook: use another folder (persisting to it), or null to go back to memory only. */
export function setLedgerDir(dir: string | null): void {
  if (timer) clearTimeout(timer)
  timer = null
  dirOverride = dir
  persist = dir !== null
  months.clear()
  pending.clear()
}

/** Test hook: drop everything in memory (lines on disk stay). */
export function resetLedgerCache(): void {
  flushLedger()
  months.clear()
}

/** A small marker file in the ledger folder (one-time jobs such as the migration). */
export function writeMarker(name: string): void {
  if (!persist) return
  mkdirSync(ledgerDir(), { recursive: true })
  writeFileSync(join(ledgerDir(), name), new Date().toISOString(), 'utf8')
}

export function hasMarker(name: string): boolean {
  return persist && existsSync(join(ledgerDir(), name))
}
