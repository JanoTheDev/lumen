import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addEntry,
  dayMarkdown,
  dayOf,
  emptyDay,
  JournalStore,
  summarize
} from '../../src/main/journal/journal'
import { tempDir } from '../helpers/fixtures'

describe('learning journal', () => {
  const dirs: { cleanup(): void }[] = []
  afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))

  it('questions are written redacted (review low)', () => {
    const key = ['sk', 'proj', 'A'.repeat(40)].join('-')
    let day = emptyDay('2026-10-01')
    day = addEntry(day, { kind: 'question', text: `type my key ${key} into this field` })
    day = addEntry(day, { kind: 'question', text: 'my password is hunter22' })
    const all = JSON.stringify(day) + dayMarkdown(day)
    expect(all).not.toContain(key)
    expect(all).not.toContain('hunter22')
    expect(day.questions[0]).toContain('type my key')
  })

  it('adds de-duplicated entries and renders a markdown note', () => {
    let day = emptyDay('2026-10-01')
    day = addEntry(day, { kind: 'lesson', title: 'Add an object' })
    day = addEntry(day, { kind: 'shortcut', text: 'Ctrl+S (save, Notepad)' })
    day = addEntry(day, { kind: 'question', text: 'how do I   add a cube' })
    const same = addEntry(day, { kind: 'lesson', title: 'Add an object' })
    expect(same).toBe(day)
    expect(dayMarkdown(day)).toBe(
      [
        '# Learning journal: 2026-10-01',
        '',
        '## Lessons finished',
        '',
        '- Add an object',
        '',
        '## New shortcuts',
        '',
        '- Ctrl+S (save, Notepad)',
        '',
        '## Questions you asked',
        '',
        '- how do I add a cube',
        ''
      ].join('\n')
    )
  })

  it('summarizes the week', () => {
    const a = addEntry(emptyDay('2026-09-30'), { kind: 'lesson', title: 'Cut a clip' })
    const b = addEntry(addEntry(emptyDay('2026-10-01'), { kind: 'question', text: 'q1' }), {
      kind: 'app',
      name: 'Blender'
    })
    expect(summarize([a, b], 'week')).toBe(
      'This week: You finished 1 lesson: Cut a clip. You worked in Blender. You asked me 1 question.'
    )
    expect(summarize([emptyDay('2026-10-01')], 'today')).toBe(
      'Your journal has nothing for today yet.'
    )
  })

  it('stores per day, lists days and clears', () => {
    const d = tempDir('journal-')
    dirs.push(d)
    const store = new JournalStore(join(d.dir, 'journal'))
    const now = new Date(2026, 9, 1, 12).getTime()
    store.add({ kind: 'question', text: 'hello' }, now)
    store.add({ kind: 'lesson', title: 'L1' }, now - 86_400_000)
    expect(store.days()).toEqual(['2026-10-01', '2026-09-30'])
    expect(store.markdown('2026-10-01')).toContain('- hello')
    expect(store.markdown('../x')).toBeNull()
    expect(store.recent(2, now).map((x) => x.lessons.length)).toEqual([0, 1])
    expect(dayOf(now)).toBe('2026-10-01')
    store.clear()
    expect(existsSync(join(d.dir, 'journal'))).toBe(false)
  })
})
