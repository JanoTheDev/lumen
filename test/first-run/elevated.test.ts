import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
const h = vi.hoisted(() => ({
  agent: null as null | {
    running: boolean
    impl: string
    hasCapability: (c: string) => boolean
    request: ReturnType<typeof vi.fn>
  }
}))
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => h.agent }))
vi.mock('../../src/main/keys/vault', () => ({ KEY_PROVIDERS: [], hasKey: () => false }))
vi.mock('../../src/main/ipc/wake', () => ({ installWakeModel: vi.fn() }))
vi.mock('../../src/main/ipc/settings', () => ({ patchConfig: vi.fn() }))
vi.mock('../../src/main/speech/hotkey', () => ({ captureNextHotkey: vi.fn() }))
vi.mock('../../src/main/speech/wake', () => ({ wakeStatus: () => ({}) }))

import { elevated, resetElevatedCache } from '../../src/main/first-run/ipc'

function agent(reply: () => Promise<unknown>, caps = ['system-info']): typeof h.agent {
  return {
    running: true,
    impl: 'native',
    hasCapability: (c) => caps.includes(c),
    request: vi.fn(reply)
  }
}

describe('first-run elevation probe', () => {
  beforeEach(() => resetElevatedCache())

  it('asks the agent once and caches the answer', async () => {
    h.agent = agent(() => Promise.resolve({ elevated: true, osBuild: 26200, osRevision: 1 }))
    expect(await elevated()).toBe(true)
    expect(await elevated()).toBe(true)
    expect(h.agent?.request).toHaveBeenCalledTimes(1)
    expect(h.agent?.request.mock.calls[0][0]).toBe('system_info')
  })

  it('reports not elevated without an agent, on errors or without the capability', async () => {
    h.agent = null
    expect(await elevated()).toBe(false)
    h.agent = agent(() => Promise.reject(new Error('down')))
    expect(await elevated()).toBe(false)
    h.agent = agent(() => Promise.resolve({ elevated: true }), [])
    expect(await elevated()).toBe(false)
    expect(h.agent?.request).not.toHaveBeenCalled()
  })
})
