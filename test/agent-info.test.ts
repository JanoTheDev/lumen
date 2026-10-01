import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { agentImplInfo } from '../src/main/ipc/agent'

const base = { impl: null, version: null, running: true, lastError: null }

describe('agentImplInfo', () => {
  it('no bridge', () => {
    expect(agentImplInfo(null)).toEqual({ impl: null, version: null, protocol: null, error: null })
  })

  it('a ready agent reports native, its version and protocol 2', () => {
    expect(agentImplInfo({ ...base, impl: 'native', version: '0.1.0' })).toEqual({
      impl: 'native',
      version: '0.1.0',
      protocol: 2,
      error: null
    })
  })

  it('still in the handshake', () => {
    expect(agentImplInfo(base)).toEqual({ impl: null, version: null, protocol: null, error: null })
  })

  it('not running: the reason', () => {
    expect(
      agentImplInfo({ ...base, running: false, lastError: 'native agent not found (x.exe)' })
    ).toEqual({
      impl: null,
      version: null,
      protocol: null,
      error: 'native agent not found (x.exe)'
    })
  })
})
