import { describe, expect, it } from 'vitest'
import { GRAMMAR, SHEET_EXTRAS } from '../../src/main/a11y/grammar/en'
import {
  GATE_WHEN,
  IDLE_CONTEXT,
  commandSheetRows,
  type CommandContext
} from '../../src/main/a11y/voice-commands'
import { A11yCommands } from '../../src/main/a11y/dispatch'
import { lessonSheetEntries } from '../../src/main/a11y/lesson-sheet'
import { LESSON_COMMANDS } from '../../src/shared/events'
import { parseLessonCommand } from '../../src/main/teach/commands'
import { buildSections, filterRows } from '../../src/renderer/src/a11y/sheet'
import { fakeA11yIo } from '../helpers/fake-a11y-io'

const MARKS: CommandContext = { ...IDLE_CONTEXT, marksShown: true }

describe('command sheet rows', () => {
  it('lists every grammar entry (one row per phrase and gate)', () => {
    const rows = commandSheetRows(IDLE_CONTEXT)
    for (const e of [...GRAMMAR, ...SHEET_EXTRAS]) {
      expect(
        rows.some(
          (r) => r.say === e.say && r.when === ((e.gate && GATE_WHEN[e.gate]) || undefined)
        ),
        e.say
      ).toBe(true)
    }
  })

  it('marks what applies right now', () => {
    const idle = commandSheetRows(IDLE_CONTEXT)
    const hide = (rows: typeof idle): boolean | undefined =>
      rows.find((r) => r.say === 'hide numbers')?.now
    expect(hide(idle)).toBe(false)
    expect(hide(commandSheetRows(MARKS))).toBe(true)
    expect(idle.find((r) => r.say === 'show numbers')?.now).toBe(true)
    const guide = commandSheetRows({ ...IDLE_CONTEXT, guideActive: true })
    expect(guide.find((r) => r.category === 'guide' && r.say === 'next')?.now).toBe(true)
  })
})

describe('lesson words on the sheet (07 T16)', () => {
  it('has one row per lesson command, applying only during a lesson', () => {
    const entries = lessonSheetEntries()
    expect(entries.map((e) => e.id.slice('lesson.'.length)).sort()).toEqual(
      [...LESSON_COMMANDS].sort()
    )
    for (const e of entries) expect(parseLessonCommand(e.say), e.say).toBe(e.id.slice(7))
    const idle = commandSheetRows(IDLE_CONTEXT, entries).filter((r) => r.when === 'during a lesson')
    expect(idle).toHaveLength(entries.length)
    expect(idle.every((r) => !r.now)).toBe(true)
    const inLesson = commandSheetRows({ ...IDLE_CONTEXT, lessonActive: true }, entries)
    expect(inLesson.find((r) => r.say === 'do it for me')).toMatchObject({ now: true })
  })
})

describe('sheet sections and search', () => {
  it('puts context commands first, then categories', () => {
    const sections = buildSections(commandSheetRows(MARKS))
    expect(sections[0].id).toBe('now')
    expect(sections[0].rows.some((r) => r.say === 'hide numbers')).toBe(true)
    expect(sections.map((s) => s.id)).toContain('keyboard')
    const idle = buildSections(commandSheetRows(IDLE_CONTEXT))
    expect(idle[0].id).not.toBe('now')
  })

  it('every row lands in exactly one section', () => {
    const rows = commandSheetRows(MARKS)
    const total = buildSections(rows).reduce((n, s) => n + s.rows.length, 0)
    expect(total).toBe(rows.length)
  })

  it('search matches all words over phrase, meaning and context', () => {
    const rows = commandSheetRows(IDLE_CONTEXT)
    expect(filterRows(rows, 'scroll down').every((r) => /scroll/i.test(r.say + r.does))).toBe(true)
    expect(filterRows(rows, 'numbers shown').length).toBeGreaterThan(0)
    expect(filterRows(rows, 'zzzz')).toEqual([])
    expect(filterRows(rows, '  ')).toHaveLength(rows.length)
  })
})

describe('"what can I say"', () => {
  it('opens the sheet', async () => {
    const f = fakeA11yIo()
    const a = new A11yCommands(f.io)
    expect(a.tryHandle('what can I say')).not.toBeNull()
    await f.settle()
    expect(f.calls.help).toBe(1)
  })

  it('falls back to a text answer when the sheet cannot open', () => {
    const f = fakeA11yIo({ help: false })
    const r = new A11yCommands(f.io).tryHandle('help') as { response: { text: string } }
    expect(r.response.text).toMatch(/You can say/)
  })
})
