import { describe, expect, it } from 'vitest'
import { fileRecord, normCombo, reversalFor, type RecordCtx } from '../../src/main/undo/records'

const ctx: RecordCtx = {
  id: 'u1',
  at: 1,
  taskId: 't1',
  process: 'Notepad.exe',
  title: 'notes - Notepad'
}

describe('undo records', () => {
  it('typing is undone with the app’s own Ctrl+Z, flagged best effort', () => {
    const r = reversalFor({ type: 'type', text: 'hello world' }, ctx)
    expect(r).toMatchObject({
      what: 'typed 11 characters',
      process: 'notepad.exe',
      reversal: { kind: 'keys', combo: 'ctrl+z', count: 1 },
      approximate: true
    })
  })

  it('hotkeys: inverse, app undo, harmless and irreversible', () => {
    expect(reversalFor({ type: 'hotkey', keys: ['Ctrl', 'Plus'] }, ctx).reversal).toEqual({
      kind: 'keys',
      combo: 'ctrl+minus',
      count: 1
    })
    expect(reversalFor({ type: 'hotkey', keys: ['ctrl', 'v'] }, ctx).reversal).toMatchObject({
      combo: 'ctrl+z'
    })
    expect(reversalFor({ type: 'hotkey', keys: ['ctrl', 'a'] }, ctx).reversal).toEqual({
      kind: 'noop'
    })
    const save = reversalFor({ type: 'hotkey', keys: ['ctrl', 's'] }, ctx)
    expect(save.reversal).toBeNull()
    expect(save.irreversible).toMatch(/saved/)
    const send = reversalFor({ type: 'hotkey', keys: ['ctrl', 'enter'] }, ctx)
    expect(send.reversal).toBeNull()
    expect(send.irreversible).toMatch(/sent/)
    expect(reversalFor({ type: 'hotkey', keys: ['ctrl', 'shift', 'k'] }, ctx).irreversible).toMatch(
      /don’t know/
    )
  })

  it('clicks on Send are honest; plain clicks are unknown', () => {
    const send = reversalFor({ type: 'click_element', text: 'Send' }, ctx)
    expect(send.reversal).toBeNull()
    expect(send.irreversible).toContain('can’t be taken back')
    const click = reversalFor({ type: 'click', x: 1, y: 2 }, ctx)
    expect(click.reversal).toBeNull()
    expect(click.irreversible).toMatch(/click/)
  })

  it('URLs close the tab or go back, in the browser only', () => {
    const open = reversalFor({ type: 'open_url', url: 'https://example.com/a' }, ctx)
    expect(open).toMatchObject({
      what: 'opened example.com',
      needsBrowser: true,
      process: undefined,
      reversal: { combo: 'ctrl+w' }
    })
    expect(reversalFor({ type: 'navigate_url', url: 'https://x.org' }, ctx).reversal).toMatchObject(
      { combo: 'alt+left' }
    )
    expect(reversalFor({ type: 'open_url', url: 'mailto:a@b.c' }, ctx).reversal).toBeNull()
  })

  it('UIA: old value restored, toggle and expand reversed', () => {
    expect(
      reversalFor(
        {
          type: 'uia_act',
          elementId: 'e1',
          action: 'set_value',
          value: 'new',
          description: 'Name'
        },
        { ...ctx, oldValue: 'old' }
      )
    ).toMatchObject({ what: 'changed “Name”', reversal: { kind: 'set-value', value: 'old' } })
    expect(
      reversalFor({ type: 'uia_act', elementId: 'e1', action: 'set_value', value: 'x' }, ctx)
        .reversal
    ).toMatchObject({ combo: 'ctrl+z' })
    expect(
      reversalFor({ type: 'uia_act', elementId: 'e2', action: 'toggle' }, ctx).reversal
    ).toEqual({ kind: 'uia', elementId: 'e2', action: 'toggle' })
    expect(
      reversalFor({ type: 'uia_act', elementId: 'e3', action: 'expand' }, ctx).reversal
    ).toMatchObject({ action: 'collapse' })
    expect(
      reversalFor(
        { type: 'uia_act', elementId: 'e4', action: 'invoke', description: 'Pay now' },
        ctx
      ).irreversible
    ).toContain('can’t be taken back')
  })

  it('scrolls reverse direction; input steps count their undos', () => {
    expect(reversalFor({ type: 'scroll', direction: 'down', amount: 2 }, ctx).reversal).toEqual({
      kind: 'scroll',
      direction: 'up',
      amount: 2
    })
    const steps = reversalFor(
      {
        type: 'input',
        steps: [
          { t: 'type', text: 'abc' },
          { t: 'keys', combo: 'ctrl+v' },
          { t: 'wait', ms: 10 }
        ]
      },
      ctx
    )
    expect(steps.reversal).toEqual({ kind: 'keys', combo: 'ctrl+z', count: 2 })
    const withClick = reversalFor(
      {
        type: 'input',
        steps: [
          { t: 'click', button: 'left' },
          { t: 'type', text: 'a' }
        ]
      },
      ctx
    )
    expect(withClick.reversal).toBeNull()
  })

  it('file records point at the kept copy', () => {
    expect(fileRecord(ctx, 'C:\\x\\a.txt', 'C:\\trash\\a.txt', 'deleted')).toMatchObject({
      what: 'deleted the file a.txt',
      reversal: { kind: 'restore-file', path: 'C:\\x\\a.txt', backup: 'C:\\trash\\a.txt' }
    })
  })

  it('normalizes combos', () => {
    expect(normCombo('Control + Return')).toBe('ctrl+enter')
    expect(normCombo(['Ctrl', 'Shift', 'S'])).toBe('ctrl+shift+s')
  })
})
