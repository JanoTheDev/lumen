import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./electron-mock')).electronModule())
vi.mock('../../src/main/windows/registry', () => ({ applyUiScale: vi.fn(), broadcast: vi.fn() }))
vi.mock('../../src/main/windows/status', () => ({ hideStatus: vi.fn() }))
vi.mock('../../src/main/windows/settings', () => ({}))

import { screen } from 'electron'
import { electronMock, invokeHandler, resetElectronMock, setDisplays } from './electron-mock'
import { DUAL_150_100 } from './displays'
import { tempDir } from './fixtures'
import { registerSettingsIpc } from '../../src/main/ipc/settings'
import { invalidateConfig, setConfigDir } from '../../src/main/config'

describe('electron-mock helper', () => {
  let tmp: ReturnType<typeof tempDir>
  const deps = {
    setHotkey: vi.fn(async () => {}),
    applyListenerState: vi.fn(),
    applyDwellState: vi.fn()
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    tmp = tempDir()
    setConfigDir(tmp.dir)
    invalidateConfig()
    resetElectronMock()
    registerSettingsIpc(deps)
  })
  afterEach(() => {
    tmp.cleanup()
    vi.restoreAllMocks()
  })

  it('invokes ipcMain handlers registered by the code under test', async () => {
    const cfg = (await invokeHandler('settings:get')) as { hotkey: string }
    expect(typeof cfg.hotkey).toBe('string')

    await invokeHandler('settings:patch', { hotkey: 'Ctrl+Alt+K' })
    expect(deps.setHotkey).toHaveBeenCalledWith('Ctrl+Alt+K')

    deps.setHotkey.mockClear()
    await expect(invokeHandler('settings:patch', { hotkey: 42 })).resolves.toEqual({
      error: 'E_INVALID'
    })
    expect(deps.setHotkey).not.toHaveBeenCalled()
  })

  it('serves configurable displays and exposes spies', () => {
    setDisplays(DUAL_150_100)
    expect(screen.getAllDisplays()).toHaveLength(2)
    expect(screen.dipToScreenPoint({ x: 1920, y: 0 })).toEqual({ x: 2880, y: 0 })
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled()
  })
})
