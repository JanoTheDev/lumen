// Local cache of how-to answers + the paid-search budget (05 T36), in one small JSON file
// (`~/.ai-overlay/howto-cache.json`). Answers are keyed by app + major version + goal words; a
// miss is cached for a day too, so an app nobody documents does not cost a search every task.
// Paid searches: at most PAID_PER_TASK per task and PAID_PER_DAY per local day. No Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { goalMatch } from './notes'
import { majorOf } from './version'
import type { AppIdentity, HowtoResult } from './types'

export const HIT_TTL_MS = 30 * 24 * 60 * 60_000
export const MISS_TTL_MS = 24 * 60 * 60_000
export const MAX_ENTRIES = 200
export const PAID_PER_TASK = 2
export const PAID_PER_DAY = 10
const MATCH_MIN = 0.8

interface Entry {
  appId: string
  major: string
  goal: string
  at: number
  result: Omit<HowtoResult, 'costUsd' | 'searches'>
}

interface CacheFile {
  version: 1
  entries: Entry[]
  paid: { date: string; count: number }
}

const dayOf = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class HowtoCache {
  private data: CacheFile | null = null
  private readonly perTask = new Map<string, number>()

  constructor(
    /** null: memory only (tests, or before the app enables it). */
    private readonly path: string | null,
    private readonly now: () => number = Date.now
  ) {}

  private load(): CacheFile {
    if (this.data) return this.data
    let f: CacheFile = { version: 1, entries: [], paid: { date: '', count: 0 } }
    try {
      if (this.path && existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as CacheFile
        if (raw?.version === 1 && Array.isArray(raw.entries))
          f = { version: 1, entries: raw.entries, paid: raw.paid ?? f.paid }
      }
    } catch {
      /* a broken cache starts empty */
    }
    this.data = f
    return f
  }

  private save(): void {
    if (!this.path || !this.data) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      renameSync(tmp, this.path)
    } catch {
      /* the cache is an optimisation */
    }
  }

  get(id: AppIdentity, goal: string): HowtoResult | null {
    const f = this.load()
    const t = this.now()
    const major = majorOf(id.version)
    let best: Entry | null = null
    let score = 0
    for (const e of f.entries) {
      if (e.appId !== id.appId || e.major !== major) continue
      const ttl = e.result.from === 'none' ? MISS_TTL_MS : HIT_TTL_MS
      if (t - e.at > ttl) continue
      const s = goalMatch(e.goal, goal)
      if (s >= MATCH_MIN && s > score) {
        best = e
        score = s
      }
    }
    if (!best) return null
    const from = best.result.from === 'none' ? 'none' : 'cache'
    return { ...best.result, from, costUsd: 0, searches: 0 }
  }

  put(id: AppIdentity, goal: string, result: HowtoResult): void {
    const f = this.load()
    const major = majorOf(id.version)
    const t = this.now()
    f.entries = f.entries.filter(
      (e) =>
        !(e.appId === id.appId && e.major === major && goalMatch(e.goal, goal) >= 0.9) &&
        t - e.at <= HIT_TTL_MS
    )
    const kept: Entry['result'] = {
      app: result.app,
      version: result.version,
      goal: result.goal,
      steps: result.steps,
      sources: result.sources,
      from: result.from,
      ...(result.note ? { note: result.note } : {})
    }
    f.entries.push({ appId: id.appId, major, goal, at: t, result: kept })
    if (f.entries.length > MAX_ENTRIES) f.entries = f.entries.slice(-MAX_ENTRIES)
    this.save()
  }

  /** Paid searches left for this task right now (per-task and per-day caps). */
  paidLeft(taskId: string): number {
    const f = this.load()
    const today = dayOf(this.now())
    const usedToday = f.paid.date === today ? f.paid.count : 0
    const usedTask = this.perTask.get(taskId) ?? 0
    return Math.max(0, Math.min(PAID_PER_TASK - usedTask, PAID_PER_DAY - usedToday))
  }

  notePaid(taskId: string, searches: number): void {
    if (searches <= 0) return
    const f = this.load()
    const today = dayOf(this.now())
    f.paid = { date: today, count: (f.paid.date === today ? f.paid.count : 0) + searches }
    this.perTask.set(taskId, (this.perTask.get(taskId) ?? 0) + searches)
    if (this.perTask.size > 50) this.perTask.delete(this.perTask.keys().next().value!)
    this.save()
  }
}
