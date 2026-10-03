import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { setStatus } = vi.hoisted(() => ({ setStatus: vi.fn() }))
vi.mock('../../../src/main/windows/assistant', () => ({ setStatus }))

import { setConfigDir } from '../../../src/main/config'
import {
  addNote,
  clearNotes,
  deleteNote,
  getNote,
  handleNoteCommand,
  listNotes,
  matchTakeNote,
  MAX_NOTES,
  notesFile,
  updateNote
} from '../../../src/main/speech/dictation/notes'
import { flushDictationStats, loadStats, summarize } from '../../../src/main/speech/dictation/stats'

const fakeKey = (): string => ['sk', 'proj', 'B'.repeat(40)].join('-')

describe('matchTakeNote', () => {
  it.each([
    ['take a note buy milk', 'Buy milk'],
    ['Take a note: call the dentist on Friday.', 'Call the dentist on Friday.'],
    ['take a note that the meeting moved to 3', 'The meeting moved to 3'],
    ['make a note of the parking spot, level 2', 'The parking spot, level 2'],
    ['Note to self, renew the passport', 'Renew the passport'],
    ['jot this down: 42 is the answer', '42 is the answer'],
    ['hey lumen, take a quick note pick up keys', 'Pick up keys'],
    ['save a note remember the milk', 'Remember the milk'],
    ['make a note to call mom', 'To call mom']
  ])('%s', (utterance, text) => {
    expect(matchTakeNote(utterance)).toBe(text)
  })

  it('command without text', () => {
    expect(matchTakeNote('take a note')).toBe('')
    expect(matchTakeNote('Take a note.')).toBe('')
  })

  it.each([
    'what notes do I have',
    'take notes during the meeting',
    'open my notebook',
    'take a note in OneNote saying hi',
    'make a note on the document',
    'add a note to the slide',
    'this is a note about cats'
  ])('not a note command: %s', (utterance) => {
    expect(matchTakeNote(utterance)).toBeNull()
  })
})

describe('notes store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-notes-'))
    setConfigDir(dir)
    setStatus.mockClear()
  })
  afterEach(() => {
    flushDictationStats()
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds with a source, lists newest first, edits and deletes', () => {
    const a = addNote({ text: ' first ', t: 1 })
    const b = addNote({
      text: 'Quote from the page',
      via: 'web',
      source: { title: 'An article', url: 'https://example.com/a' },
      t: 2
    })
    expect(a.text).toBe('first')
    expect(a.via).toBe('manual')
    expect(b.source).toEqual({ title: 'An article', url: 'https://example.com/a' })
    expect(listNotes().map((n) => n.id)).toEqual([b.id, a.id])
    expect(updateNote(a.id, 'first, edited', 5)).toMatchObject({
      text: 'first, edited',
      updated: 5
    })
    expect(updateNote('missing', 'x')).toBeNull()
    expect(updateNote(a.id, '   ')).toBeNull()
    expect(getNote(a.id)?.text).toBe('first, edited')
    expect(deleteNote(a.id)).toBe(true)
    expect(deleteNote(a.id)).toBe(false)
    expect(listNotes()).toHaveLength(1)
    clearNotes()
    expect(listNotes()).toEqual([])
  })

  it('rejects empty text, drops non-http urls, redacts secrets', () => {
    expect(() => addNote({ text: '  ' })).toThrow()
    const n = addNote({ text: `key ${fakeKey()}`, source: { url: 'javascript:alert(1)' } })
    expect(n.source).toBeUndefined()
    expect(readFileSync(notesFile(), 'utf8')).not.toContain(fakeKey())
  })

  it('keeps at most MAX_NOTES', () => {
    const notes = Array.from({ length: MAX_NOTES }, (_, i) => ({
      id: `id-${i}`,
      t: i,
      text: `n${i}`,
      via: 'manual'
    }))
    mkdirSync(dirname(notesFile()), { recursive: true })
    writeFileSync(notesFile(), JSON.stringify({ v: 1, notes }))
    addNote({ text: 'newest', t: MAX_NOTES })
    const list = listNotes()
    expect(list).toHaveLength(MAX_NOTES)
    expect(list[0].text).toBe('newest')
    expect(list.at(-1)?.text).toBe('n1')
  })

  it('"take a note" saves, counts words and tells the user', async () => {
    expect(await handleNoteCommand('take a note buy oat milk')).toBe(true)
    expect(listNotes()[0]).toMatchObject({ text: 'Buy oat milk', via: 'voice' })
    expect(summarize(loadStats()).totalWords).toBe(3)
    expect(setStatus).toHaveBeenCalledWith(
      'answer',
      expect.stringContaining('Noted'),
      undefined,
      4000
    )
  })

  it('"take a note" alone asks for the text; other utterances pass', async () => {
    expect(await handleNoteCommand('take a note')).toBe(true)
    expect(listNotes()).toEqual([])
    expect(await handleNoteCommand('what time is it')).toBe(false)
    expect(setStatus).toHaveBeenCalledTimes(1)
  })
})
