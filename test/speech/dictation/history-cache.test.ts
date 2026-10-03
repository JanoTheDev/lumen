import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads.files.push(String(args[0]))
    return fs.readFileSync(...args)
  }) as typeof fs.readFileSync
  return { ...fs, readFileSync, default: { ...fs, readFileSync } }
})

import { setConfigDir } from '../../../src/main/config'
import {
  appendHistory,
  clearHistory,
  KEEP_DAYS,
  listHistory,
  MAX_ENTRIES,
  toEntry
} from '../../../src/main/speech/dictation/history'
import { dictationDir } from '../../../src/main/speech/dictation/recovery'
import {
  flushDictationStats,
  loadStats,
  recordStats,
  statsFile,
  summarize
} from '../../../src/main/speech/dictation/stats'

const DAY = 86_400_000
let dir: string
const historyFile = (): string => join(dictationDir(), 'history.jsonl')
const historyReads = (): number => reads.files.filter((f) => f.endsWith('history.jsonl')).length
const statsReads = (): number => reads.files.filter((f) => f.endsWith('stats.json')).length
const lines = (): string[] => readFileSync(historyFile(), 'utf8').trim().split('\n')

function seed(n: number, t: number): void {
  mkdirSync(dictationDir(), { recursive: true })
  const text = Array.from({ length: n }, (_, i) =>
    JSON.stringify(toEntry({ raw: `w${i} ${'x'.repeat(3000)}`, text: `w${i}`, t }, t))
  )
  writeFileSync(historyFile(), text.map((l) => `${l}\n`).join(''))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-history-cache-'))
  setConfigDir(dir)
  reads.files.length = 0
})
afterEach(() => {
  flushDictationStats()
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('dictation history append', () => {
  it('reads the file once for 100 appends to a near-full history', () => {
    const now = Date.now()
    seed(MAX_ENTRIES - 50, now)
    for (let i = 0; i < 100; i++)
      appendHistory(toEntry({ raw: `a${i}`, text: `a${i}`, t: now }, now), now)
    expect(historyReads()).toBe(1)
  })

  it('compacts past MAX_ENTRIES + 50 and keeps the newest', () => {
    const now = Date.now()
    seed(MAX_ENTRIES + 40, now)
    for (let i = 0; i < 10; i++)
      appendHistory(toEntry({ raw: `a${i}`, text: `a${i}`, t: now }, now), now)
    expect(lines()).toHaveLength(MAX_ENTRIES + 50)
    appendHistory(toEntry({ raw: 'last', text: 'last', t: now }, now), now)
    expect(lines()).toHaveLength(MAX_ENTRIES)
    const list = listHistory(now)
    expect(list[0].text).toBe('last')
    expect(list[1].text).toBe('a9')
    expect(list[MAX_ENTRIES - 1].text).toBe('w51')
  })

  it('compacts when the oldest entry is past KEEP_DAYS', () => {
    const now = Date.now()
    seed(3, now)
    appendHistory(toEntry({ raw: 'b', text: 'b', t: now }, now), now)
    expect(lines()).toHaveLength(4)
    const later = now + (KEEP_DAYS + 1) * DAY
    appendHistory(toEntry({ raw: 'c', text: 'c', t: later }, later), later)
    expect(listHistory(later).map((e) => e.text)).toEqual(['c'])
    expect(lines()).toHaveLength(1)
  })

  it('keeps counting correctly after clear and outside edits', () => {
    const now = Date.now()
    seed(MAX_ENTRIES + 45, now)
    appendHistory(toEntry({ raw: 'a', text: 'a', t: now }, now), now)
    clearHistory()
    for (let i = 0; i < 10; i++)
      appendHistory(toEntry({ raw: `c${i}`, text: `c${i}`, t: now }, now), now)
    expect(lines()).toHaveLength(10)
    seed(MAX_ENTRIES + 50, now)
    appendHistory(toEntry({ raw: 'd', text: 'd', t: now }, now), now)
    expect(lines()).toHaveLength(MAX_ENTRIES)
  })
})

describe('dictation stats writes', () => {
  it('reads the file once and serves new values from memory', () => {
    const now = Date.now()
    for (let i = 0; i < 100; i++) recordStats({ words: 2, t: now })
    expect(summarize(loadStats(), now).totalWords).toBe(200)
    expect(statsReads()).toBeLessThanOrEqual(1)
    flushDictationStats()
    expect(JSON.parse(readFileSync(statsFile(), 'utf8')).days).toBeTruthy()
  })
})
