import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConfigDir } from '../../../src/main/config'
import {
  addToStats,
  countWords,
  dayKey,
  emptyStats,
  loadStats,
  recordStats,
  resetStats,
  statsFile,
  summarize
} from '../../../src/main/speech/dictation/stats'

const DAY = 86_400_000
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime()

describe('dictation stats (pure)', () => {
  it('counts words with letters or digits only', () => {
    expect(countWords('Hello, world - it is 9 now.')).toBe(6)
    expect(countWords('  ')).toBe(0)
  })

  it('adds per local day and computes pace from timed dictations', () => {
    const now = noon(2026, 10, 1)
    let s = emptyStats()
    s = addToStats(s, { words: 30, durationMs: 12_000, t: now })
    s = addToStats(s, { words: 10, t: now })
    expect(s.days[dayKey(now)]).toEqual({ words: 40, sessions: 2, timedWords: 30, timedMs: 12_000 })
    const sum = summarize(s, now)
    expect(sum.todayWords).toBe(40)
    expect(sum.totalWords).toBe(40)
    expect(sum.sessions).toBe(2)
    expect(sum.wpm).toBe(150)
    // Typing 40 words at 40 wpm = 60 s; speaking 12 s + 10 words at 150 wpm (4 s).
    expect(sum.savedMs).toBe(44_000)
  })

  it('no time saved below zero and no pace without durations', () => {
    const now = noon(2026, 10, 1)
    const s = addToStats(emptyStats(), { words: 2, durationMs: 60_000, t: now })
    expect(summarize(s, now).savedMs).toBe(0)
    expect(summarize(addToStats(emptyStats(), { words: 5, t: now }), now).wpm).toBe(0)
  })

  it('streak counts consecutive days ending today or yesterday', () => {
    const today = noon(2026, 10, 10)
    let s = emptyStats()
    for (const d of [7, 8, 9]) s = addToStats(s, { words: 3, t: noon(2026, 10, d) })
    expect(summarize(s, today).streak).toBe(3)
    s = addToStats(s, { words: 1, t: today })
    expect(summarize(s, today).streak).toBe(4)
    expect(summarize(s, today + 2 * DAY).streak).toBe(0)
  })

  it('week words cover the last 7 days', () => {
    const now = noon(2026, 10, 10)
    let s = addToStats(emptyStats(), { words: 5, t: now - 6 * DAY })
    s = addToStats(s, { words: 7, t: now - 8 * DAY })
    const sum = summarize(s, now)
    expect(sum.weekWords).toBe(5)
    expect(sum.totalWords).toBe(12)
  })

  it('drops days older than about 400 days', () => {
    const now = noon(2026, 10, 10)
    let s = addToStats(emptyStats(), { words: 5, t: now - 500 * DAY })
    s = addToStats(s, { words: 1, t: now })
    expect(Object.keys(s.days)).toEqual([dayKey(now)])
  })
})

describe('dictation stats (file)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-stats-'))
    setConfigDir(dir)
  })
  afterEach(() => {
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('records, reloads and resets', () => {
    recordStats({ words: 4, t: Date.now() })
    recordStats({ words: 0, t: Date.now() })
    expect(summarize(loadStats()).totalWords).toBe(4)
    expect(summarize(loadStats()).sessions).toBe(1)
    resetStats()
    expect(summarize(loadStats()).totalWords).toBe(0)
  })

  it('a corrupt or hostile file loads as empty or sanitised', () => {
    mkdirSync(dirname(statsFile()), { recursive: true })
    writeFileSync(statsFile(), '{nope')
    expect(loadStats()).toEqual(emptyStats())
    writeFileSync(
      statsFile(),
      JSON.stringify({ days: { '../x': { words: 9 }, '2026-10-01': { words: -3, sessions: 'a' } } })
    )
    expect(loadStats().days).toEqual({
      '2026-10-01': { words: 0, sessions: 0, timedWords: 0, timedMs: 0 }
    })
  })
})
