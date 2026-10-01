import { beforeEach, describe, expect, it, vi } from 'vitest'

const setObsSettings = vi.hoisted(() => vi.fn(() => ({ ok: true, persisted: true })))
vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/teach/bridges', () => ({
  allBridgeStatus: vi.fn(),
  bridgeStatus: vi.fn(),
  clearObsSettings: vi.fn(),
  revealBlenderAddon: vi.fn(),
  setObsSettings
}))

import { invokeHandler, resetElectronMock } from '../helpers/electron-mock'
import { registerBridgesIpc } from '../../src/main/ipc/bridges'

beforeEach(() => {
  resetElectronMock()
  setObsSettings.mockClear()
  registerBridgesIpc()
})

describe('bridges IPC (review low)', () => {
  it('an invalid OBS payload is E_INVALID and stores nothing', async () => {
    expect(await invokeHandler('bridges:obs-set', { port: 'x' })).toEqual({ error: 'E_INVALID' })
    expect(setObsSettings).not.toHaveBeenCalled()
  })

  it('a valid one is stored', async () => {
    expect(await invokeHandler('bridges:obs-set', { port: 4455 })).toEqual({
      ok: true,
      persisted: true
    })
  })
})
