import { describe, expect, it } from 'vitest'
import {
  Recording,
  checkOf,
  describeStep,
  draftLesson,
  editDraft,
  mainApp,
  skeleton,
  waitsFor,
  type RawUiaEvent,
  type RecordedApp
} from '../../src/main/teach/recorder'

const settings: RecordedApp = { id: 'windows', name: 'Windows 11', process: 'SystemSettings.exe' }
const el = (name: string, role = 'list item', value?: string): RawUiaEvent['element'] => ({
  name,
  role,
  ...(value !== undefined ? { value } : {})
})

describe('Recording privacy', () => {
  it('never keeps typed text: a value event is only "text entered in <field>"', () => {
    const r = new Recording(0)
    r.uia({ kind: 'value', element: el('Search', 'edit', 'my secret password') }, 10, settings)
    r.uia({ kind: 'value', element: el('Search', 'edit', 'my secret password 2') }, 20, settings)
    expect(r.events).toEqual([
      { at: 20, kind: 'text', name: 'Search', role: 'edit', app: settings }
    ])
    expect(JSON.stringify(r.events)).not.toContain('secret')
  })

  it('drops Lumen’s hotkey, Lumen’s own windows and anything said to Lumen', () => {
    const r = new Recording(0, { hotkey: 'Ctrl+Shift+Space' })
    expect(r.key('ctrl+shift+space', 1)).toBe(false)
    expect(
      r.uia({ kind: 'invoked', element: el('Send', 'button') }, 2, {
        id: 'lumen',
        name: 'Lumen',
        process: 'Lumen.exe'
      })
    ).toBe(false)
    expect(r.uia({ kind: 'window-opened', element: el('Lumen assistant', 'window') }, 3)).toBe(
      false
    )
    r.hold(true)
    expect(r.uia({ kind: 'invoked', element: el('Save', 'button') }, 4)).toBe(false)
    r.hold(false)
    expect(r.key('Ctrl+S', 5)).toBe(true)
    expect(r.events).toHaveLength(1)
  })

  it('needs a name or automation id, and merges quick repeats', () => {
    const r = new Recording(0)
    expect(r.uia({ kind: 'invoked', element: { role: 'button' } }, 1)).toBe(false)
    r.uia({ kind: 'invoked', element: el('OK', 'button') }, 100)
    r.uia({ kind: 'invoked', element: el('OK', 'button') }, 300)
    r.uia({ kind: 'invoked', element: el('OK', 'button') }, 2000)
    expect(r.events).toHaveLength(2)
  })

  it('attaches a requested screenshot to the last step, or the next', () => {
    const r = new Recording(0)
    r.addShot({ data: 'a', mime: 'image/jpeg' })
    r.uia({ kind: 'invoked', element: el('One', 'button') }, 1)
    expect(r.events[0].shot).toBe(0)
    r.addShot({ data: 'b', mime: 'image/jpeg' })
    r.uia({ kind: 'invoked', element: el('Two', 'button') }, 2000)
    expect(r.events[0].shot).toBe(0)
    expect(r.events[1].shot).toBe(1)
  })
})

describe('skeleton', () => {
  it('turns "turn on dark mode" into select / select steps with context', () => {
    const r = new Recording(0)
    r.uia({ kind: 'focused', element: el('Personalization') }, 1000, settings)
    r.uia({ kind: 'selected', element: el('Personalization') }, 1100, settings)
    r.uia({ kind: 'invoked', element: el('Colors', 'button') }, 3000, settings)
    r.uia({ kind: 'window-opened', element: el('Colors', 'window') }, 3200, settings)
    r.uia({ kind: 'selected', element: el('Dark') }, 6000, settings)
    const steps = skeleton(r.events)
    expect(steps.map((s) => [s.kind, s.name])).toEqual([
      ['selected', 'Personalization'],
      ['invoked', 'Colors'],
      ['selected', 'Dark']
    ])
    expect(steps[1].opened).toEqual(['Colors'])
    expect(describeStep(steps[1], 1)).toBe(
      '2. clicked button “Colors” in Windows 11; then “Colors” opened'
    )
    expect(mainApp(steps)).toEqual(settings)
  })

  it('drops focus passing through, keeps focus that stayed, merges focus + typing', () => {
    const r = new Recording(0)
    r.uia({ kind: 'focused', element: el('A', 'button') }, 0)
    r.uia({ kind: 'focused', element: el('B', 'button') }, 100)
    r.uia({ kind: 'focused', element: el('Dark mode', 'button') }, 3000)
    r.uia({ kind: 'focused', element: el('Name', 'edit') }, 9000)
    r.uia({ kind: 'value', element: el('Name', 'edit', 'x') }, 12_000)
    r.key('Ctrl+S', 15_000)
    const steps = skeleton(r.events)
    expect(steps.map((s) => [s.kind, s.name ?? s.combo])).toEqual([
      ['focused', 'B'],
      ['focused', 'Dark mode'],
      ['text', 'Name'],
      ['key', 'Ctrl+S']
    ])
  })
})

describe('draftLesson', () => {
  const r = new Recording(0)
  r.uia({ kind: 'selected', element: el('Personalization') }, 1000, settings)
  r.uia({ kind: 'invoked', element: el('Oops', 'button') }, 2000, settings)
  r.uia({ kind: 'selected', element: el('Dark') }, 6000, settings)
  r.key('Ctrl+W', 8000, settings)
  const steps = skeleton(r.events)

  it('uses the model’s words, in order, and drops what it left out', () => {
    const lesson = draftLesson(
      steps,
      {
        title: 'Turn on dark mode',
        steps: [
          {
            from: 1,
            say: 'In the left list, select Personalization.',
            why: 'Colors live here.',
            hint: ''
          },
          {
            from: 3,
            say: 'Just open Choose your mode and select Dark.',
            why: '',
            hint: 'It is near the top.'
          },
          { from: 2, say: 'Out of order', why: '', hint: '' },
          { from: 9, say: 'Not recorded', why: '', hint: '' }
        ]
      },
      { app: settings }
    )!
    expect(lesson.id).toBe('windows-draft-turn-on-dark-mode')
    expect(lesson.tags).toEqual(['recorded'])
    expect(lesson.steps.map((s) => s.say)).toEqual([
      'In the left list, select Personalization.',
      'Open Choose your mode and select Dark.'
    ])
    expect(lesson.steps[1].hints).toEqual(['It is near the top.'])
    expect(lesson.steps[0].target).toEqual({
      element: { name: 'Personalization', role: 'list item' }
    })
    expect(lesson.steps[1].check).toEqual({
      type: 'anyOf',
      checks: [
        { type: 'uia-event', event: 'selected', match: { name: 'Dark', role: 'list item' } },
        {
          type: 'vision',
          prompt: 'Did the user complete this step: Open Choose your mode and select Dark.'
        }
      ]
    })
  })

  it('falls back to plain lines without the model, and the user’s title wins', () => {
    const lesson = draftLesson(steps, null, { app: settings, title: 'dark mode' })!
    expect(lesson.title).toBe('Dark mode')
    expect(lesson.steps.map((s) => s.say)).toEqual([
      'Select Personalization.',
      'Click Oops.',
      'Select Dark.',
      'Press Control W.'
    ])
    expect(lesson.steps[3].check).toMatchObject({ type: 'anyOf' })
    expect((lesson.steps[3].check as { checks: unknown[] }).checks[0]).toEqual({
      type: 'keypress',
      combo: 'Ctrl+W'
    })
    expect(lesson.steps[3].target).toEqual({ shortcut: 'Ctrl+W' })
    expect(waitsFor(lesson.steps[1].check)).toBe('a click on “Oops”')
    expect(draftLesson([], null, { app: settings })).toBeNull()
  })

  it('applies the user’s edits: order, dropped steps, new say lines follow the vision check', () => {
    const lesson = draftLesson(steps, null, { app: settings })!
    const [a, , c] = lesson.steps
    const edited = editDraft(lesson, {
      title: 'Dark mode',
      steps: [
        { id: c.id, say: 'Pick Dark.' },
        { id: a.id, say: 'Open Personalization.' },
        { id: 'nope', say: 'Ignored.' }
      ]
    })!
    expect(edited.title).toBe('Dark mode')
    expect(edited.steps.map((s) => s.say)).toEqual(['Pick Dark.', 'Open Personalization.'])
    expect(edited.steps[0].check).toEqual(checkOf(steps[2], 'Pick Dark.'))
    expect(editDraft(lesson, { title: 'x', steps: [] })).toBeNull()
  })
})
