import { describe, expect, it } from 'vitest'
import type { DictationHistoryEntry, Note } from '../../../src/shared/dictation-history'
import {
  ago,
  appLabel,
  canTypeAgain,
  duration,
  heardText,
  historyMeta,
  noteMeta
} from '../../../src/renderer/src/panel/home/dictation-view'

const NOW = new Date(2026, 9, 10, 15).getTime()
const entry = (p: Partial<DictationHistoryEntry> = {}): DictationHistoryEntry => ({
  id: 'x',
  t: NOW - 5 * 60_000,
  app: 'notepad.exe',
  raw: 'um hello there',
  text: 'Hello there.',
  words: 2,
  source: 'hotkey',
  ok: true,
  ...p
})

describe('canTypeAgain (L5)', () => {
  it('hides "type it again" for text with a secret taken out', () => {
    expect(canTypeAgain(entry())).toBe(true)
    expect(canTypeAgain(entry({ text: 'my key is [redacted:api-key]' }))).toBe(false)
  })
})

describe('home dictation view', () => {
  it('relative times', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('just now')
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 min ago')
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(ago(NOW - 26 * 3_600_000, NOW)).toBe('yesterday')
  })

  it('durations', () => {
    expect(duration(45_000)).toBe('45 s')
    expect(duration(12 * 60_000)).toBe('12 min')
    expect(duration(125 * 60_000)).toBe('2 h 5 min')
    expect(duration(120 * 60_000)).toBe('2 h')
  })

  it('history meta and transcript', () => {
    expect(appLabel('WINWORD.EXE')).toBe('WINWORD')
    expect(historyMeta(entry(), NOW)).toBe('5 min ago · notepad · 2 words')
    expect(historyMeta(entry({ ok: false, app: '', words: 1 }), NOW)).toBe(
      '5 min ago · 1 word · not typed'
    )
    expect(heardText(entry())).toBe('um hello there')
    expect(heardText(entry({ raw: 'Hello  there.' }))).toBeNull()
  })

  it('note meta', () => {
    const n: Note = { id: 'n', t: NOW - 10_000, text: 't', via: 'web' }
    expect(noteMeta({ ...n, source: { url: 'https://www.example.com/x' } }, NOW)).toBe(
      'just now · from the web · example.com'
    )
    expect(noteMeta({ ...n, via: 'manual' }, NOW)).toBe('just now')
  })
})
