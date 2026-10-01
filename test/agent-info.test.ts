import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { agentImplInfo } from '../src/main/ipc/agent'

const base = { impl: null, version: null, protocol: 1 as const, running: true, implFallback: null }

describe('agentImplInfo', () => {
  it('no bridge', () => {
    expect(agentImplInfo(null)).toEqual({
      impl: null,
      version: null,
      protocol: null,
      fallback: null
    })
  })

  it('native v2 reports impl and version', () => {
    expect(agentImplInfo({ ...base, impl: 'native', version: '0.1.0', protocol: 2 })).toEqual({
      impl: 'native',
      version: '0.1.0',
      protocol: 2,
      fallback: null
    })
  })

  it('a v1 agent is the Python one, with the fallback reason', () => {
    const r = agentImplInfo({ ...base, implFallback: 'native agent lacks execute' })
    expect(r).toEqual({
      impl: 'python',
      version: null,
      protocol: 1,
      fallback: 'native agent lacks execute'
    })
  })

  it('not running yet', () => {
    expect(agentImplInfo({ ...base, running: false })).toMatchObject({ impl: null, protocol: null })
  })
})
