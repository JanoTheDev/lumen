import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge } from '../../src/main/agent/bridge'
import { fakeSpawn, flushMicrotasks, splitAt } from './fake-child'

describe('fake-child helper', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('drives a v1 bridge: handshake, respondTo and a UTF-8 event split mid-character', async () => {
    const { spawnFn, latest } = fakeSpawn({ framing: 'v1' })
    const bridge = new AgentBridge({ spawnFn })
    await bridge.start()
    const child = latest()
    expect(bridge.protocol).toBe(1)
    expect(child.last('ping')).toBeDefined()

    child.respondTo('active_window', 'Größe — 日本')
    await expect(bridge.activeWindow()).resolves.toBe('Größe — 日本')

    const seen: unknown[] = []
    bridge.onEvent('update', (d) => seen.push(d?.text))
    const line = JSON.stringify({ event: 'update', text: 'Größe — 日本' }) + '\n'
    const bytes = Buffer.byteLength(line)
    for (let cut = 1; cut < bytes; cut++) child.emitRaw(splitAt(line, [cut]))
    expect(seen).toHaveLength(bytes - 1)
    expect(new Set(seen)).toEqual(new Set(['Größe — 日本']))
    bridge.stop()
  })

  it('drives a v2 bridge through ready + init', async () => {
    const { spawnFn, latest } = fakeSpawn({ framing: 'v2' })
    const bridge = new AgentBridge({
      spawnFn,
      initArgs: () => ({
        hotkey: 'Ctrl+Shift+Space',
        wake: { enabled: false, phrase: '', cancelPhrases: [] },
        dwell: { enabled: false, ms: 1400, cooldownMs: 1500 },
        logLevel: 'info'
      })
    })
    await bridge.start()
    await flushMicrotasks()
    expect(bridge.protocol).toBe(2)
    expect(latest().last('init')?.v).toBe(2)
    bridge.stop()
  })
})
