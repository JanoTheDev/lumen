// Electron side of the a11y shortcuts: the help key next to the binder, and action errors.
import { describe, expect, it, vi } from 'vitest'
import type { ConfigV2 } from '../../src/shared/config'

const h = vi.hoisted(() => ({
  keys: new Map<string, () => void>(),
  cfg: null as unknown as ConfigV2,
  patched: [] as ((next: ConfigV2, prev: ConfigV2) => void)[]
}))

vi.mock('electron', () => {
  // Like Electron: a key this app already holds cannot be registered again.
  const globalShortcut = {
    register: (acc: string, fn: () => void) => {
      if (h.keys.has(acc)) return false
      h.keys.set(acc, fn)
      return true
    },
    unregister: (acc: string) => void h.keys.delete(acc)
  }
  return { globalShortcut, default: { globalShortcut } }
})
vi.mock('../../src/main/config', () => ({ loadConfig: () => h.cfg }))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/ipc/settings', () => ({
  onConfigPatched: (fn: (next: ConfigV2, prev: ConfigV2) => void) => h.patched.push(fn)
}))
vi.mock('../../src/main/query/cancel', () => ({ cancelAll: () => {} }))
vi.mock('../../src/main/windows/assistant', () => ({}))
vi.mock('../../src/main/windows/home', () => ({}))
vi.mock('../../src/main/windows/ui-mode', () => ({ uiV2: () => true }))
vi.mock('../../src/main/windows/command-sheet', () => ({ show: () => {} }))
vi.mock('../../src/main/a11y/dwell', () => ({ dwellController: () => null }))

import { makeConfig } from '../helpers/fixtures'
import type { A11yCommands } from '../../src/main/a11y/dispatch'
import { helpShortcut, installHelpShortcut } from '../../src/main/a11y/help'
import { installShortcuts } from '../../src/main/a11y/install-shortcuts'

const feedback = vi.fn()
const showGrid = vi.fn(() => {
  throw new Error('No screen found')
})
const commands = { grid: { shown: false }, showGrid } as unknown as A11yCommands

function patch(next: ConfigV2): void {
  const prev = h.cfg
  h.cfg = next
  for (const fn of h.patched) fn(next, prev)
}

h.cfg = makeConfig()

describe('installShortcuts', () => {
  installHelpShortcut()
  installShortcuts({ commands: () => commands, toggleKeyboard: () => {}, feedback })

  it('gives the help shortcut a key an a11y shortcut held until then', () => {
    expect(h.keys.has('Ctrl+Shift+F7')).toBe(true)
    patch(makeConfig({ a11y: { helpHotkey: 'Ctrl+Shift+F7' } }))
    expect(helpShortcut()).toBe('Ctrl+Shift+F7')
    expect(h.keys.has('Ctrl+Shift+F1')).toBe(false)
  })

  it('turns an action error into feedback instead of throwing in the key callback', () => {
    patch(makeConfig())
    const grid = h.keys.get('Ctrl+Shift+F7')
    expect(grid).toBeDefined()
    expect(() => grid!()).not.toThrow()
    expect(showGrid).toHaveBeenCalled()
    expect(feedback).toHaveBeenCalledWith('No screen found', false)
  })
})
