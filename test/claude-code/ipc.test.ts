// Claude Code IPC: bad payloads return E_INVALID and never reach the copilot or the hooks file.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { copilot, hooksApply, saveSettings, ready } = vi.hoisted(() => ({
  ready: { on: true },
  copilot: {
    list: vi.fn(() => []),
    send: vi.fn(),
    interrupt: vi.fn(async () => true),
    close: vi.fn(() => true),
    open: vi.fn()
  },
  hooksApply: vi.fn(() => ({ ok: true })),
  saveSettings: vi.fn((s: unknown) => s)
}))

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/claude-code', () => ({
  allProjects: () => [],
  copilotStore: () => ({
    settings: () => ({
      cliPath: '',
      autopilot: 'careful',
      allowedTools: [],
      projects: [],
      hooksObserver: false,
      model: '',
      confidence: 0.8
    }),
    saveSettings
  }),
  getBridge: () => ({ list: () => [], answer: vi.fn(() => true) }),
  getCopilot: () => (ready.on ? copilot : null),
  hookBase: () => 'http://127.0.0.1:4000',
  hooksApply,
  hooksPreview: vi.fn()
}))
vi.mock('../../src/main/claude-code/cli', () => ({
  cliStatus: async () => ({ found: false, installUrl: 'https://x' })
}))

import { invokeHandler, resetElectronMock } from '../helpers/electron-mock'
import { registerClaudeCodeIpc } from '../../src/main/ipc/claude-code'

beforeEach(() => {
  resetElectronMock()
  vi.clearAllMocks()
  registerClaudeCodeIpc()
})

describe('claude IPC', () => {
  it('a valid request before the copilot starts is "not ready", not E_INVALID (review low)', async () => {
    ready.on = false
    try {
      expect(await invokeHandler('claude:send', { id: 'cc_abc123', text: 'hi' })).toEqual({
        ok: false,
        error: 'Claude Code is not ready yet.'
      })
      expect(await invokeHandler('claude:open', { project: 'C:/x' })).toMatchObject({ ok: false })
      expect(await invokeHandler('claude:send', { id: 'nope', text: 'x' })).toEqual({
        error: 'E_INVALID'
      })
    } finally {
      ready.on = true
    }
  })

  it('validates payloads', async () => {
    expect(await invokeHandler('claude:send', { id: 'nope', text: 'x' })).toEqual({
      error: 'E_INVALID'
    })
    expect(await invokeHandler('claude:send', { id: 'cc_abc123', text: '' })).toEqual({
      error: 'E_INVALID'
    })
    expect(await invokeHandler('claude:interrupt', '../x')).toEqual({ error: 'E_INVALID' })
    expect(await invokeHandler('claude:hooks-apply', true, 'short')).toEqual({ error: 'E_INVALID' })
    expect(await invokeHandler('claude:settings-set', { hooksObserver: true })).toEqual({
      error: 'E_INVALID'
    })
    expect(await invokeHandler('claude:settings-set', { autopilot: 'yolo' })).toEqual({
      error: 'E_INVALID'
    })
    expect(copilot.send).not.toHaveBeenCalled()
    expect(hooksApply).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('passes valid requests through', async () => {
    expect(await invokeHandler('claude:send', { id: 'cc_abc123', text: 'run tests' })).toEqual({
      ok: true
    })
    expect(copilot.send).toHaveBeenCalledWith('cc_abc123', 'run tests')
    expect(await invokeHandler('claude:hooks-apply', false, 'a'.repeat(64))).toEqual({ ok: true })
    expect(hooksApply).toHaveBeenCalledWith(false, 'a'.repeat(64))
    await invokeHandler('claude:settings-set', { autopilot: 'full' })
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autopilot: 'full' }))
    const st = (await invokeHandler('claude:status')) as { hookPort: number }
    expect(st.hookPort).toBe(4000)
  })
})
