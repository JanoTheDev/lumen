import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/registry', () => ({ applyUiScale: vi.fn(), broadcast: vi.fn() }))
vi.mock('../../src/main/windows/status', () => ({ hideStatus: vi.fn() }))
vi.mock('../../src/main/windows/settings', () => ({}))

import { invokeHandler, resetElectronMock } from '../helpers/electron-mock'
import { tempDir } from '../helpers/fixtures'
import { onConfigPatched, registerSettingsIpc } from '../../src/main/ipc/settings'
import { invalidateConfig, loadConfig, setConfigDir } from '../../src/main/config'

describe('a11y:apply-profile', () => {
  let tmp: ReturnType<typeof tempDir>
  const deps = {
    setHotkey: vi.fn(async () => {}),
    applyDictationHotkey: vi.fn(async () => {}),
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

  it('saves the merged profiles and re-applies dwell', async () => {
    const seen = vi.fn()
    const off = onConfigPatched(seen)
    const cfg = (await invokeHandler('a11y:apply-profile', ['motor-pointer'])) as {
      dwellClick: { enabled: boolean }
    }
    off()
    expect(cfg.dwellClick.enabled).toBe(true)
    expect(loadConfig().a11y.profiles).toEqual(['motor-pointer'])
    expect(deps.applyDwellState).toHaveBeenCalled()
    expect(seen).toHaveBeenCalledOnce()
  })

  it('rejects unknown ids', async () => {
    await expect(invokeHandler('a11y:apply-profile', ['nope'])).resolves.toEqual({
      error: 'E_INVALID'
    })
  })
})
