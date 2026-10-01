import { describe, expect, it } from 'vitest'
import { makeConfig } from '../helpers/fixtures'
import {
  ShortcutBinder,
  gateOpen,
  normalizeAccelerator,
  planShortcuts,
  toElectron
} from '../../src/main/a11y/shortcuts'
import { A11Y_DEFAULTS, configV2Schema } from '../../src/shared/config'

const OPEN = { dwellOn: true, lessonRunning: true }
const CLOSED = { dwellOn: false, lessonRunning: false }

describe('a11y shortcuts config', () => {
  it('has defaults and fills them into configs saved before the section existed', () => {
    const cfg = makeConfig()
    expect(cfg.a11y.shortcuts).toEqual(A11Y_DEFAULTS.shortcuts)
    const a11y: Partial<typeof cfg.a11y> = { ...cfg.a11y }
    delete a11y.shortcuts
    const old = configV2Schema.parse({ ...cfg, a11y })
    expect(old.a11y.shortcuts.dwellPause).toBe('Ctrl+Shift+F8')
  })

  it('accepts "" and rejects junk', () => {
    const base = makeConfig()
    const ok = { ...base, a11y: { ...base.a11y, shortcuts: { ...base.a11y.shortcuts, grid: '' } } }
    expect(configV2Schema.safeParse(ok).success).toBe(true)
    const bad = {
      ...base,
      a11y: { ...base.a11y, shortcuts: { ...base.a11y.shortcuts, grid: 'rm -rf' } }
    }
    expect(configV2Schema.safeParse(bad).success).toBe(false)
  })
})

describe('planShortcuts', () => {
  it('keeps keys away from the switch keys while switch scanning is on', () => {
    const base = makeConfig()
    const shortcuts = { ...base.a11y.shortcuts, grid: 'F8' }
    const on = makeConfig({
      a11y: { shortcuts, switch: { enabled: true, keys: ['Space', 'f8'] } }
    })
    const grid = (c: typeof base): unknown =>
      planShortcuts(c, OPEN).status.find((s) => s.action === 'grid')
    expect(grid(on)).toMatchObject({ state: 'conflict', with: 'a switch key' })
    const off = makeConfig({ a11y: { shortcuts, switch: { enabled: false, keys: ['F8'] } } })
    expect(grid(off)).toMatchObject({ state: 'bound' })
  })

  it('binds every default when all gates are open, with no clash with the other Lumen keys', () => {
    const plan = planShortcuts(makeConfig(), OPEN)
    expect(plan.status.every((s) => s.state === 'bound')).toBe(true)
    expect(plan.bind).toHaveLength(Object.keys(A11Y_DEFAULTS.shortcuts).length)
  })

  it('holds dwell pause only while dwell is on and lesson keys only during a lesson', () => {
    const plan = planShortcuts(makeConfig(), CLOSED)
    const inactive = plan.status.filter((s) => s.state === 'inactive').map((s) => s.action)
    expect(inactive).toEqual(['dwellPause', 'lessonNext', 'lessonBack', 'lessonHelp', 'lessonDoIt'])
    expect(plan.bind.map((b) => b.action)).not.toContain('dwellPause')
    expect(gateOpen('focusBar', CLOSED)).toBe(true)
  })

  it('reports clashes with the assistant hotkey, help, Home and each other', () => {
    const cfg = makeConfig({
      hotkey: 'Ctrl+Shift+Space',
      a11y: {
        helpHotkey: 'Ctrl+Shift+F1',
        shortcuts: {
          ...A11Y_DEFAULTS.shortcuts,
          focusBar: 'control+shift+space',
          repeat: 'Ctrl+Shift+F1',
          pin: 'Ctrl+Shift+H',
          close: 'Ctrl+Shift+F6',
          numbers: 'Ctrl+Shift+F6',
          grid: ''
        }
      },
      ui: { homeHotkey: 'Ctrl+Shift+H' }
    })
    const by = Object.fromEntries(planShortcuts(cfg, OPEN).status.map((s) => [s.action, s]))
    expect(by.focusBar).toMatchObject({ state: 'conflict', with: 'the assistant hotkey' })
    expect(by.repeat).toMatchObject({ state: 'conflict', with: 'the "what can I say" shortcut' })
    expect(by.pin).toMatchObject({ state: 'conflict', with: 'the Home shortcut' })
    // First in table order keeps a shared key.
    expect(by.close.state).toBe('bound')
    expect(by.numbers).toMatchObject({ state: 'conflict', with: 'Close the answer' })
    expect(by.grid.state).toBe('off')
  })

  it('ignores the dictation hotkey while dictation is off', () => {
    const shortcuts = { ...A11Y_DEFAULTS.shortcuts, cancel: 'Ctrl+Shift+D' }
    const on = makeConfig({ a11y: { shortcuts } })
    const off = makeConfig({ a11y: { shortcuts }, dictation: { enabled: false } })
    const state = (c: typeof on): string | undefined =>
      planShortcuts(c, OPEN).status.find((s) => s.action === 'cancel')?.state
    expect(state(on)).toBe('conflict')
    expect(state(off)).toBe('bound')
  })
})

describe('accelerators', () => {
  it('normalizes modifier names, order and arrow aliases', () => {
    expect(normalizeAccelerator('Shift+Control+F2')).toBe('ctrl+shift+f2')
    expect(normalizeAccelerator('CmdOrCtrl+Alt+ArrowRight')).toBe('ctrl+alt+right')
    expect(toElectron('Win+Shift+K')).toBe('Super+Shift+K')
  })
})

describe('ShortcutBinder', () => {
  function setup(taken: string[] = []): {
    binder: ShortcutBinder
    held: Map<string, () => void>
    ran: string[]
  } {
    const held = new Map<string, () => void>()
    const ran: string[] = []
    const binder = new ShortcutBinder(
      {
        register: (acc, fn) => {
          if (taken.includes(acc)) return false
          if (acc === 'Bad+') throw new Error('bad accelerator')
          held.set(acc, fn)
          return true
        },
        unregister: (acc) => held.delete(acc)
      },
      (a) => ran.push(a)
    )
    return { binder, held, ran }
  }

  it('registers the plan, runs the action, and drops keys that leave the plan', () => {
    const t = setup()
    t.binder.sync([
      { action: 'grid', accelerator: 'Ctrl+Shift+F7' },
      { action: 'cancel', accelerator: 'Ctrl+Shift+F9' }
    ])
    t.held.get('Ctrl+Shift+F7')?.()
    expect(t.ran).toEqual(['grid'])
    t.binder.sync([{ action: 'cancel', accelerator: 'Ctrl+Shift+F9' }])
    expect([...t.held.keys()]).toEqual(['Ctrl+Shift+F9'])
    t.binder.clear()
    expect(t.held.size).toBe(0)
  })

  it('marks keys another app holds (or that Electron rejects) as taken', () => {
    const t = setup(['Ctrl+Shift+F7'])
    const plan = planShortcuts(makeConfig(), CLOSED)
    t.binder.sync([...plan.bind, { action: 'pin', accelerator: 'Bad+' }])
    const status = t.binder.withFailures(plan.status)
    expect(status.find((s) => s.action === 'grid')?.state).toBe('taken')
    expect(status.find((s) => s.action === 'cancel')?.state).toBe('bound')
  })
})
