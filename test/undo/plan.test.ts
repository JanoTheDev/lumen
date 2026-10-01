import { describe, expect, it } from 'vitest'
import { planUndo, reversalActions, undoReport, UndoStack } from '../../src/main/undo/plan'
import type { UndoRecord } from '../../src/main/undo/records'

const rec = (id: string, over: Partial<UndoRecord> = {}): UndoRecord => ({
  id,
  at: 1000,
  taskId: 't1',
  what: `step ${id}`,
  process: 'notepad.exe',
  reversal: { kind: 'keys', combo: 'ctrl+z', count: 1 },
  ...over
})

describe('UndoStack', () => {
  it('takes the newest first, skips no-ops and old records', () => {
    const s = new UndoStack(10, 5000)
    s.add(rec('a'))
    s.add(rec('b', { reversal: { kind: 'noop' } }))
    s.add(rec('c', { at: 3000 }))
    expect(s.take(5, 4000).map((r) => r.id)).toEqual(['c', 'a'])
    expect(s.take(5, 9000).map((r) => r.id)).toEqual([])
    expect(s.take(1, 4000).map((r) => r.id)).toEqual(['c'])
  })

  it('"what you just did" is the newest task', () => {
    const s = new UndoStack()
    s.add(rec('a', { taskId: 't1' }))
    s.add(rec('b', { taskId: 't2' }))
    s.add(rec('c', { taskId: 't2' }))
    expect(s.lastTask(2000).map((r) => r.id)).toEqual(['c', 'b'])
  })

  it('caps its size and removes undone records', () => {
    const s = new UndoStack(2)
    s.add(rec('a'))
    s.add(rec('b'))
    s.add(rec('c'))
    expect(s.size).toBe(2)
    s.remove(new Set(['c']))
    expect(s.take(5, 1000).map((r) => r.id)).toEqual(['b'])
  })
})

describe('planUndo', () => {
  it('runs reversals in the same window, newest first', () => {
    const p = planUndo([rec('b'), rec('a')], { process: 'notepad.exe' })
    expect(p.run.map((r) => r.record.id)).toEqual(['b', 'a'])
    expect(p.run[0].actions).toEqual([{ type: 'input', steps: [{ t: 'keys', combo: 'ctrl+z' }] }])
  })

  it('never presses Ctrl+Z in another app, and stops there', () => {
    const p = planUndo([rec('b', { title: 'notes - Notepad' }), rec('a')], {
      process: 'winword.exe'
    })
    expect(p.run).toEqual([])
    expect(p.skipped[0].why).toContain('switch back to it')
    expect(p.skipped[1].why).toContain('came before')
  })

  it('stops at the first step it cannot undo, honestly', () => {
    const p = planUndo(
      [
        rec('c'),
        rec('b', { reversal: null, irreversible: '“Send” can’t be taken back' }),
        rec('a')
      ],
      { process: 'notepad.exe' }
    )
    expect(p.run.map((r) => r.record.id)).toEqual(['c'])
    expect(p.skipped.map((s) => s.record.id)).toEqual(['b', 'a'])
    expect(undoReport([p.run[0].record], p.skipped)).toBe(
      'Undone: step c. Not undone: step b, because “Send” can’t be taken back. Not undone: step a, because it came before a step I couldn’t undo.'
    )
  })

  it('browser reversals need the browser in front', () => {
    const p = planUndo([rec('a', { process: undefined, needsBrowser: true })], {
      isBrowser: false
    })
    expect(p.skipped[0].why).toContain('browser')
  })

  it('file restores and UIA reversals need no window match', () => {
    const p = planUndo(
      [
        rec('f', {
          process: undefined,
          reversal: { kind: 'restore-file', path: 'a', backup: 'b' }
        }),
        rec('u', { reversal: { kind: 'uia', elementId: 'e', action: 'toggle' } })
      ],
      { process: 'other.exe' }
    )
    expect(p.run.map((r) => r.actions.length)).toEqual([0, 1])
  })
})

describe('reversalActions + report', () => {
  it('maps every reversal kind', () => {
    expect(reversalActions({ kind: 'keys', combo: 'ctrl+z', count: 3 }, 'x')[0]).toMatchObject({
      type: 'input',
      steps: [{}, {}, {}]
    })
    expect(reversalActions({ kind: 'set-value', elementId: 'e', value: 'v' }, 'Name')).toEqual([
      { type: 'uia_act', elementId: 'e', action: 'set_value', value: 'v', description: 'Name' }
    ])
    expect(reversalActions({ kind: 'scroll', direction: 'up', amount: 2 }, '')).toEqual([
      { type: 'scroll', direction: 'up', amount: 2 }
    ])
    expect(reversalActions({ kind: 'noop' }, '')).toEqual([])
  })

  it('says when there is nothing and when the app’s undo was used', () => {
    expect(undoReport([], [])).toBe('There is nothing of mine to undo.')
    expect(
      undoReport(
        [
          rec('a', { what: 'typed 3 characters', approximate: true }),
          rec('b', { what: 'pressed Ctrl+V' })
        ],
        []
      )
    ).toBe(
      'Undone: typed 3 characters and pressed Ctrl+V. I used the app’s own undo, so check it looks right.'
    )
  })
})
