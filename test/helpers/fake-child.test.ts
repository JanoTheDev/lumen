import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge } from '../../src/main/agent/bridge'
import { buildAgentInitState } from '../../src/main/agent/state'
import { DEFAULT_CONFIG } from '../../src/main/config'
import { FAKE_PATHS, fakeSpawn, flushMicrotasks, splitAt } from './fake-child'

describe('fake-child helper', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('drives a bridge: ready, respondTo and a UTF-8 event split mid-character', async () => {
    const { spawnFn, latest } = fakeSpawn()
    const bridge = new AgentBridge({ spawnFn, paths: FAKE_PATHS })
    await bridge.start()
    const child = latest()
    expect(bridge.impl).toBe('native')

    child.respondTo('active_window', { title: 'Größe — 日本' })
    await expect(bridge.activeWindow()).resolves.toBe('Größe — 日本')

    const seen: unknown[] = []
    bridge.onEvent('update', (d) => seen.push(d?.text))
    const line = JSON.stringify({ v: 2, event: 'update', data: { text: 'Größe — 日本' } }) + '\n'
    const bytes = Buffer.byteLength(line)
    for (let cut = 1; cut < bytes; cut++) child.emitRaw(splitAt(line, [cut]))
    expect(seen).toHaveLength(bytes - 1)
    expect(new Set(seen)).toEqual(new Set(['Größe — 日本']))
    bridge.stop()
  })

  it('answers init automatically', async () => {
    const { spawnFn, latest } = fakeSpawn()
    const bridge = new AgentBridge({
      spawnFn,
      paths: FAKE_PATHS,
      initArgs: () => buildAgentInitState(DEFAULT_CONFIG)
    })
    await bridge.start()
    await flushMicrotasks()
    expect(latest().last('init')?.v).toBe(2)
    bridge.stop()
  })
})
