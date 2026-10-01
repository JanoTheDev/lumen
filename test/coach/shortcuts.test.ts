import { describe, expect, it } from 'vitest'
import {
  canonCombo,
  parseShortcutTable,
  shortcutFor,
  ShortcutCoach,
  splitAccelerator,
  tipText
} from '../../src/main/coach/shortcuts'

const DAY = 86_400_000

describe('shortcut lookup', () => {
  it('reads the accelerator from a menu item name', () => {
    expect(splitAccelerator('Save\tCtrl+S')).toEqual({ action: 'save', combo: 'Ctrl+S' })
    expect(splitAccelerator('Save &As...  Ctrl+Shift+S')).toEqual({
      action: 'save as',
      combo: 'Ctrl+Shift+S'
    })
    expect(splitAccelerator('Render Image (F12)')).toEqual({ action: 'render image', combo: 'F12' })
    expect(splitAccelerator('Paste')).toEqual({ action: 'paste', combo: null })
  })

  it('parses an app pack shortcuts.md table', () => {
    const md = [
      '| Action | Shortcut | Mode |',
      '| ------ | -------- | ---- |',
      '| Render image | F12 | Any |',
      '| Save file | Ctrl+S | Any |',
      '| Orbit | Middle mouse drag | Viewport |',
      '| Duplicate | Shift+D or Ctrl+D | Object |'
    ].join('\n')
    expect(parseShortcutTable(md)).toEqual({
      'render image': 'F12',
      'save file': 'Ctrl+S',
      duplicate: 'Shift+D'
    })
  })

  it('name accelerator, then pack, then the common list', () => {
    expect(shortcutFor('Save file', { 'save file': 'Ctrl+S' })).toEqual({
      action: 'save file',
      combo: 'Ctrl+S'
    })
    expect(shortcutFor('Select All', null)).toEqual({ action: 'select all', combo: 'Ctrl+A' })
    expect(shortcutFor('Properties', null)).toBeNull()
  })

  it('canonical combos and tips per mode', () => {
    expect(canonCombo('control + shift + s')).toBe('Ctrl+Shift+S')
    expect(tipText({ action: 'save', combo: 'Ctrl+S' }, 'keys')).toContain('Ctrl+S does Save')
    expect(tipText({ action: 'save', combo: 'Ctrl+S' }, 'voice')).toContain('say “press control S”')
  })
})

describe('ShortcutCoach', () => {
  const make = (): ShortcutCoach =>
    new ShortcutCoach({ entries: {} }, () => ({ after: 3, mode: 'keys' }))

  it('tips after N menu uses, at most once a day and three times in all', () => {
    const c = make()
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 0)).toBeNull()
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 1)).toBeNull()
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 2)).toContain('Ctrl+S')
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 3)).toBeNull()
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, DAY + 3)).toContain('Ctrl+S')
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 2 * DAY + 4)).toContain('Ctrl+S')
    expect(c.onInvoke('notepad', 'Save\tCtrl+S', null, 3 * DAY + 5)).toBeNull()
  })

  it('stops once the shortcut is used three times (learned)', () => {
    const c = make()
    for (let i = 0; i < 3; i++) c.onInvoke('notepad', 'Save', null, i)
    expect(c.onCombo('notepad', 'Ctrl+S')).toBeNull()
    expect(c.onCombo('notepad', 'ctrl+s')).toBeNull()
    expect(c.onCombo('notepad', 'Ctrl+S')).toMatchObject({ action: 'save', learned: true })
    expect(c.onInvoke('notepad', 'Save', null, 5 * DAY)).toBeNull()
    expect(c.learned()).toHaveLength(1)
  })

  it('combos in another app do not count; muted means no tips', () => {
    const c = make()
    for (let i = 0; i < 2; i++) c.onInvoke('notepad', 'Save', null, i)
    expect(c.onCombo('word', 'Ctrl+S')).toBeNull()
    c.setMuted(true)
    expect(c.onInvoke('notepad', 'Save', null, 3)).toBeNull()
    expect(c.snapshot().entries['notepad\u0000save'].menu).toBe(3)
  })
})
