// Local dictation stats (04 T46): words, speaking pace, time saved against typing and the
// day streak. Only counts per local day are kept (no text), in ~/.ai-overlay/dictation/
// stats.json. Never sent anywhere.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { DictationStatsView } from '@shared/dictation-history'
import { dictationDir } from './recovery'

export interface DayStats {
  words: number
  sessions: number
  /** Words of dictations whose speaking time is known, and that time. */
  timedWords: number
  timedMs: number
}

export interface DictationStats {
  v: 1
  days: Record<string, DayStats>
}

/** Average typing pace the saving is measured against. */
export const TYPING_WPM = 40
/** Speaking pace assumed for dictations without a known duration. */
export const SPEAKING_WPM = 150
const KEEP_DAYS = 400
const SAVE_DELAY_MS = 2000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export const emptyStats = (): DictationStats => ({ v: 1, days: {} })

/** Local calendar day of an epoch ms. */
export function dayKey(t: number): string {
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Adds one dictation; drops days older than KEEP_DAYS. Pure. */
export function addToStats(
  stats: DictationStats,
  e: { words: number; durationMs?: number; t: number }
): DictationStats {
  const key = dayKey(e.t)
  const prev = stats.days[key] ?? { words: 0, sessions: 0, timedWords: 0, timedMs: 0 }
  const words = Math.max(0, Math.round(e.words))
  const ms = num(e.durationMs)
  const day: DayStats = {
    words: prev.words + words,
    sessions: prev.sessions + 1,
    timedWords: prev.timedWords + (ms ? words : 0),
    timedMs: prev.timedMs + ms
  }
  const cutoff = dayKey(e.t - KEEP_DAYS * 86_400_000)
  const days: Record<string, DayStats> = {}
  for (const [k, v] of Object.entries(stats.days)) if (k >= cutoff) days[k] = v
  days[key] = day
  return { v: 1, days }
}

function streakOf(days: Record<string, DayStats>, now: number): number {
  const has = (t: number): boolean => (days[dayKey(t)]?.words ?? 0) > 0
  // Today without dictation yet does not break a streak that ran until yesterday.
  let t = has(now) ? now : now - 86_400_000
  let n = 0
  // Step by local noon so DST changes never skip or repeat a day.
  const noon = new Date(t)
  noon.setHours(12, 0, 0, 0)
  t = noon.getTime()
  while (has(t)) {
    n++
    const d = new Date(t)
    d.setDate(d.getDate() - 1)
    t = d.getTime()
  }
  return n
}

export function summarize(
  stats: DictationStats,
  now = Date.now(),
  typingWpm = TYPING_WPM
): Omit<DictationStatsView, 'show'> {
  const today = dayKey(now)
  const weekStart = dayKey(now - 6 * 86_400_000)
  let totalWords = 0
  let weekWords = 0
  let sessions = 0
  let timedWords = 0
  let timedMs = 0
  for (const [k, d] of Object.entries(stats.days)) {
    totalWords += d.words
    sessions += d.sessions
    timedWords += d.timedWords
    timedMs += d.timedMs
    if (k >= weekStart && k <= today) weekWords += d.words
  }
  const untimedWords = totalWords - timedWords
  const speakingMs = timedMs + (untimedWords / SPEAKING_WPM) * 60_000
  const typingMs = (totalWords / typingWpm) * 60_000
  return {
    totalWords,
    todayWords: stats.days[today]?.words ?? 0,
    weekWords,
    sessions,
    wpm: timedMs > 0 ? Math.round(timedWords / (timedMs / 60_000)) : 0,
    typingWpm,
    savedMs: Math.max(0, Math.round(typingMs - speakingMs)),
    streak: streakOf(stats.days, now)
  }
}

// ---- file ----

export function statsFile(): string {
  return join(dictationDir(), 'stats.json')
}

/** Newest stats for `file`; `dirty` while they still have to be written. */
let cache: { file: string; stats: DictationStats; dirty: boolean } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let exitHooked = false

const copyStats = (s: DictationStats): DictationStats => ({ v: 1, days: { ...s.days } })

export function loadStats(): DictationStats {
  const file = statsFile()
  if (cache?.dirty && cache.file === file) return copyStats(cache.stats)
  const stats = readStats(file)
  cache = { file, stats, dirty: false }
  return copyStats(stats)
}

function readStats(file: string): DictationStats {
  if (!existsSync(file)) return emptyStats()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { days?: unknown }
    const days: Record<string, DayStats> = {}
    if (raw.days && typeof raw.days === 'object')
      for (const [k, v] of Object.entries(raw.days as Record<string, Record<string, unknown>>)) {
        if (!DAY_RE.test(k) || !v || typeof v !== 'object') continue
        days[k] = {
          words: num(v.words),
          sessions: num(v.sessions),
          timedWords: num(v.timedWords),
          timedMs: num(v.timedMs)
        }
      }
    return { v: 1, days }
  } catch {
    return emptyStats()
  }
}

function writeStats(file: string, stats: DictationStats): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(stats), 'utf8')
}

export function saveStats(stats: DictationStats): void {
  const file = statsFile()
  if (cache?.dirty && cache.file !== file) flushDictationStats()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  writeStats(file, stats)
  cache = { file, stats: copyStats(stats), dirty: false }
}

/** Writes recorded stats that are still waiting for the save timer. Sync, for quit. */
export function flushDictationStats(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!cache?.dirty) return
  cache.dirty = false
  try {
    writeStats(cache.file, cache.stats)
  } catch (e) {
    console.error('[dictation] stats not saved:', (e as Error).message)
  }
}

export function recordStats(e: { words: number; durationMs?: number; t: number }): void {
  if (e.words <= 0) return
  const file = statsFile()
  if (cache?.dirty && cache.file !== file) flushDictationStats()
  const base = cache?.file === file ? cache.stats : readStats(file)
  cache = { file, stats: addToStats(base, e), dirty: true }
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', flushDictationStats)
  }
  if (!saveTimer) {
    saveTimer = setTimeout(flushDictationStats, SAVE_DELAY_MS)
    saveTimer.unref?.()
  }
}

export function resetStats(): void {
  saveStats(emptyStats())
}
