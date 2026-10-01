import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveConfig, setConfigDir } from '../../../src/main/config'
import {
  appendHistory,
  clearHistory,
  deleteHistoryEntry,
  getHistoryEntry,
  KEEP_DAYS,
  listHistory,
  MAX_ENTRIES,
  prune,
  recordDictation,
  toEntry
} from '../../../src/main/speech/dictation/history'
import { dictationDir } from '../../../src/main/speech/dictation/recovery'
import { loadStats, summarize } from '../../../src/main/speech/dictation/stats'

const DAY = 86_400_000
// Built at runtime so no key-shaped literal sits in the repo.
const fakeKey = (): string => ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-history-'))
  setConfigDir(dir)
})
afterEach(() => {
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('dictation history', () => {
  it('records typed text, transcript, app and counts stats', () => {
    recordDictation({
      raw: 'um send it tuesday',
      text: 'Send it Tuesday.',
      app: 'notepad.exe',
      durationMs: 1500,
      source: 'auto'
    })
    const [e] = listHistory()
    expect(e).toMatchObject({
      raw: 'um send it tuesday',
      text: 'Send it Tuesday.',
      app: 'notepad.exe',
      words: 3,
      durationMs: 1500,
      source: 'auto',
      ok: true
    })
    expect(summarize(loadStats()).totalWords).toBe(3)
  })

  it('redacts secrets before storing', () => {
    const key = fakeKey()
    recordDictation({ raw: `my key is ${key}`, text: `My key is ${key}` })
    const file = readFileSync(join(dictationDir(), 'history.jsonl'), 'utf8')
    expect(file).not.toContain(key)
    expect(listHistory()[0].text).toContain('[redacted')
  })

  it('failed inserts are kept but not counted in stats', () => {
    recordDictation({ raw: 'hello there', text: 'Hello there.', ok: false })
    expect(listHistory()[0].ok).toBe(false)
    expect(summarize(loadStats()).totalWords).toBe(0)
  })

  it('off switch and private mode store nothing, stats still count', () => {
    saveConfig({ dictation: { history: false } })
    recordDictation({ raw: 'one two', text: 'One two.' })
    expect(listHistory()).toEqual([])
    saveConfig({ dictation: { history: true }, memory: { privateMode: true } })
    recordDictation({ raw: 'three', text: 'Three.' })
    expect(listHistory()).toEqual([])
    expect(summarize(loadStats()).totalWords).toBe(3)
  })

  it('lists newest first; delete and clear', () => {
    recordDictation({ raw: 'a', text: 'first', t: Date.now() - 2000 })
    recordDictation({ raw: 'b', text: 'second', t: Date.now() - 1000 })
    const list = listHistory()
    expect(list.map((e) => e.text)).toEqual(['second', 'first'])
    expect(getHistoryEntry(list[1].id)?.text).toBe('first')
    expect(deleteHistoryEntry(list[1].id)).toBe(true)
    expect(deleteHistoryEntry('nope')).toBe(false)
    expect(listHistory().map((e) => e.text)).toEqual(['second'])
    clearHistory()
    expect(listHistory()).toEqual([])
  })

  it('prunes old and surplus entries', () => {
    const now = Date.now()
    const mk = (t: number): ReturnType<typeof toEntry> => toEntry({ raw: 'x', text: 'x', t }, now)
    const entries = [
      mk(now - (KEEP_DAYS + 1) * DAY),
      ...Array.from({ length: MAX_ENTRIES + 10 }, () => mk(now))
    ]
    const kept = prune(entries, now)
    expect(kept).toHaveLength(MAX_ENTRIES)
    expect(kept.every((e) => e.t === now)).toBe(true)
  })

  it('compacts the file once it grows past the cap', () => {
    const now = Date.now()
    const lines = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) =>
      JSON.stringify(toEntry({ raw: `w${i}`, text: `w${i}`, t: now }, now))
    )
    mkdirSync(dictationDir(), { recursive: true })
    const file = join(dictationDir(), 'history.jsonl')
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
    appendHistory(toEntry({ raw: 'last', text: 'last', t: now }, now), now)
    const kept = readFileSync(file, 'utf8').trim().split('\n')
    expect(kept).toHaveLength(MAX_ENTRIES)
    expect(listHistory(now)[0].text).toBe('last')
  })

  it('caps long text and ignores empty records', () => {
    recordDictation({ raw: '', text: '  ' })
    expect(listHistory()).toEqual([])
    recordDictation({ raw: 'x', text: 'y'.repeat(9000) })
    expect(listHistory()[0].text.length).toBeLessThanOrEqual(4000)
  })
})
