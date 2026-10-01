import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V2, configV2Schema } from '@shared/config'
import {
  switchKeyClash,
  switchKeyFromEvent,
  type KeyLike
} from '../src/renderer/src/panel/settings/sections/AccessibilitySwitch'
import type { Config } from '../src/renderer/src/panel/settings/useConfig'

const press = (
  key: string,
  code = '',
  mods: Partial<KeyLike> = {}
): ReturnType<typeof switchKeyFromEvent> =>
  switchKeyFromEvent({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods
  })

describe('switch key capture', () => {
  it('takes any single key a switch interface sends', () => {
    expect(press(' ', 'Space')).toEqual({ key: 'Space' })
    expect(press('a', 'KeyA')).toEqual({ key: 'A' })
    expect(press('F13', 'F13')).toEqual({ key: 'F13' })
    expect(press('ArrowLeft', 'ArrowLeft')).toEqual({ key: 'Left' })
    expect(press('1', 'Numpad1')).toEqual({ key: 'num1' })
    expect(press('End', 'Numpad1')).toEqual({ key: 'End' })
    expect(press('+', 'NumpadAdd')).toEqual({ key: 'numadd' })
    expect(press('Enter', 'NumpadEnter')).toEqual({ key: 'Enter' })
    expect(press('MediaPlayPause', 'MediaPlayPause')).toEqual({ key: 'MediaPlayPause' })
  })

  it('refuses modifiers and keys no hook can hold', () => {
    expect(press('a', 'KeyA', { ctrlKey: true })).toHaveProperty('problem')
    expect(press('Shift', 'ShiftLeft', { shiftKey: true })).toHaveProperty('problem')
    expect(press('Escape', 'Escape')).toHaveProperty('problem')
    expect(press('ContextMenu', 'ContextMenu')).toHaveProperty('problem')
  })

  it('the config accepts captured keys and rejects the rest', () => {
    const a11y = (keys: string[]): boolean =>
      configV2Schema.shape.a11y.shape.switch.safeParse({
        ...DEFAULT_CONFIG_V2.a11y.switch,
        keys
      }).success
    expect(a11y(['Space', 'F8'])).toBe(true)
    expect(a11y(['num5', 'Capslock', 'MediaPlayPause'])).toBe(true)
    expect(a11y(['Ctrl+A'])).toBe(false)
    expect(a11y(['Escape'])).toBe(false)
  })

  it('finds clashes with the other switch and bare-key shortcuts', () => {
    const cfg = structuredClone(DEFAULT_CONFIG_V2) as unknown as Config
    cfg.a11y.shortcuts = { ...cfg.a11y.shortcuts, grid: 'F9' }
    expect(switchKeyClash('F9', cfg)).toContain('the “grid” shortcut')
    expect(switchKeyClash('space', cfg, ['Space'])).toContain('other switch')
    expect(switchKeyClash('F8', cfg)).toBe('')
  })
})
