import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, AgentError, type SpawnFn } from '../src/main/agent/bridge'
import type { AgentInitArgs } from '../src/main/agent/state'
import { buildAgentInitState } from '../src/main/agent/state'
import { DEFAULT_CONFIG } from '../src/main/config'
import { FAKE_PATHS, FakeChild, flushMicrotasks as flush } from './helpers/fake-child'

function setup(opts: { initArgs?: () => AgentInitArgs } = {}): {
  bridge: AgentBridge
  procs: FakeChild[]
  spawnFn: ReturnType<typeof vi.fn>
} {
  const procs: FakeChild[] = []
  const spawnFn = vi.fn(() => {
    const p = new FakeChild()
    procs.push(p)
    return p.asChildProcess()
  })
  const bridge = new AgentBridge({
    spawnFn: spawnFn as unknown as SpawnFn,
    paths: FAKE_PATHS,
    initArgs: opts.initArgs
  })
  return { bridge, procs, spawnFn }
}

const event = (name: string, data: Record<string, unknown> = {}): unknown => ({
  v: 2,
  event: name,
  data
})

describe('AgentBridge', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits for the ready event on start and sends nothing before init', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    expect(procs).toHaveLength(1)
    expect(procs[0].received).toEqual([])
    expect(bridge.running).toBe(true)
    bridge.stop()
  })

  it('decodes a multibyte UTF-8 char split across chunks', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const p = procs[0]
    const pending = bridge.activeWindow()
    await flush()
    const id = p.last('active_window')!.id
    const line = { v: 2, id, ok: true, result: { title: 'café \u{1F600}' } }
    const bytes = Buffer.from(JSON.stringify(line) + '\n', 'utf8')
    const eAt = bytes.indexOf(0xc3)
    const emojiAt = bytes.indexOf(0xf0)
    p.emitRaw([
      bytes.subarray(0, eAt + 1),
      bytes.subarray(eAt + 1, emojiAt + 2),
      bytes.subarray(emojiAt + 2)
    ])
    await expect(pending).resolves.toBe('café \u{1F600}')
    bridge.stop()
  })

  it('handles several lines in one chunk and a line split across chunks', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const p = procs[0]
    const events: unknown[] = []
    bridge.onEvent('hotkey-down', (d) => events.push(d))
    const lines = [1, 2, 3].map((n) => JSON.stringify(event('hotkey-down', { n })) + '\n')
    const all = lines.join('')
    const cut = lines[0].length + lines[1].length + 10
    p.emitRaw([all.slice(0, cut)])
    expect(events).toEqual([{ n: 1 }, { n: 2 }])
    p.emitRaw([all.slice(cut)])
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    bridge.stop()
  })

  it('ignores frames that are not v2', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const seen = vi.fn()
    bridge.onEvent('hotkey-down', seen)
    procs[0].emitLine({ event: 'hotkey-down' })
    expect(seen).not.toHaveBeenCalled()
    bridge.stop()
  })

  it('rejects pending calls with E_AGENT_EXIT on exit and clears their timers', async () => {
    vi.useFakeTimers()
    const { bridge, procs } = setup()
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    const p = procs[0]
    const a = bridge.request('capture', {})
    const b = bridge.execute({ type: 'type', text: 'hi' })
    await vi.advanceTimersByTimeAsync(0)
    const timersBefore = vi.getTimerCount()
    p.emitExit(1)
    await expect(a).rejects.toMatchObject({ code: 'E_AGENT_EXIT' })
    await expect(b).rejects.toBeInstanceOf(AgentError)
    // two call timers gone, one restart timer added
    expect(vi.getTimerCount()).toBe(timersBefore - 2 + 1)
    expect(bridge.lastError).toBe('agent exited (code 1)')
    bridge.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restart after stop()', async () => {
    vi.useFakeTimers()
    const { bridge, spawnFn } = setup()
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    const down = vi.fn()
    bridge.onEvent('agent-down', down)
    bridge.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(down).not.toHaveBeenCalled()
    await expect(bridge.activeWindow()).rejects.toMatchObject({ code: 'E_AGENT_NOT_RUNNING' })
  })

  it('restarts with backoff and re-sends init each time', async () => {
    vi.useFakeTimers()
    const initArgs = vi.fn(() => buildAgentInitState(DEFAULT_CONFIG))
    const { bridge, procs, spawnFn } = setup({ initArgs })
    const down = vi.fn()
    const ready = vi.fn()
    bridge.onEvent('agent-down', down)
    bridge.onEvent('agent-ready', ready)
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    expect(initArgs).toHaveBeenCalledTimes(1)

    procs[0].emitExit(1)
    expect(down).toHaveBeenLastCalledWith(
      expect.objectContaining({ willRestart: true, restartInMs: 500 })
    )
    await vi.advanceTimersByTimeAsync(499)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(procs[1].received.map((m) => m.cmd)).toEqual(['init'])
    expect(ready).toHaveBeenCalledTimes(2)

    procs[1].emitExit(1)
    expect(down).toHaveBeenLastCalledWith(expect.objectContaining({ restartInMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(spawnFn).toHaveBeenCalledTimes(3)
    expect(initArgs).toHaveBeenCalledTimes(3)
    bridge.stop()
  })

  it('a manual start() resets the restart backoff', async () => {
    vi.useFakeTimers()
    const { bridge, procs } = setup()
    const down = vi.fn()
    bridge.onEvent('agent-down', down)
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    for (let i = 0; i < 3; i++) {
      procs[i].emitExit(1)
      await vi.advanceTimersByTimeAsync(10000)
    }
    expect(down).toHaveBeenLastCalledWith(expect.objectContaining({ restartInMs: 2000 }))
    bridge.stop()
    const restarted = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await restarted
    procs[procs.length - 1].emitExit(1)
    expect(down).toHaveBeenLastCalledWith(expect.objectContaining({ restartInMs: 500 }))
    bridge.stop()
  })

  it('gives up after too many restarts in the window', async () => {
    vi.useFakeTimers()
    const { bridge, procs, spawnFn } = setup()
    const down = vi.fn()
    bridge.onEvent('agent-down', down)
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    for (let i = 0; i < 5; i++) {
      procs[i].emitExit(1)
      await vi.advanceTimersByTimeAsync(10000)
    }
    expect(spawnFn).toHaveBeenCalledTimes(6)
    procs[5].emitExit(1)
    expect(down).toHaveBeenLastCalledWith(
      expect.objectContaining({ willRestart: false, gaveUp: true })
    )
    await vi.advanceTimersByTimeAsync(60000)
    expect(spawnFn).toHaveBeenCalledTimes(6)
  })

  it('rejects immediately when stdin is not writable', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    procs[0].stdin.destroy()
    await expect(bridge.activeWindow()).rejects.toMatchObject({ code: 'E_AGENT_EPIPE' })
    bridge.stop()
  })

  it('rejects start() and emits agent-down on spawn error', async () => {
    vi.useFakeTimers()
    const procs: FakeChild[] = []
    const bridge = new AgentBridge({
      spawnFn: () => {
        const p = new FakeChild({ autoReady: false })
        procs.push(p)
        return p.asChildProcess()
      },
      paths: FAKE_PATHS
    })
    const down = vi.fn()
    bridge.onEvent('agent-down', down)
    const started = bridge.start()
    const p = procs[0]
    p.pid = undefined
    p.emit('error', new Error('spawn ENOENT'))
    await expect(started).rejects.toMatchObject({ code: 'E_AGENT_EXIT' })
    expect(down).toHaveBeenCalledWith(expect.objectContaining({ reason: 'spawn-error' }))
    expect(bridge.lastError).toMatch(/spawn ENOENT/)
    bridge.stop()
  })

  it('does not log handler exceptions as non-JSON', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const after = vi.fn()
    bridge.onEvent('hotkey-up', () => {
      throw new Error('boom')
    })
    bridge.onEvent('hotkey-up', after)
    procs[0].emitLine(event('hotkey-up'))
    expect(after).toHaveBeenCalled()
    const nonJson = logSpy.mock.calls.some((c) => String(c[0]).includes('non-JSON'))
    expect(nonJson).toBe(false)
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('handler error'))).toBe(true)
    bridge.stop()
  })

  it('applies per-command timeouts', async () => {
    vi.useFakeTimers()
    const { bridge } = setup()
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started

    const shot = bridge.request('capture', {})
    const click = bridge.execute({ type: 'click', x: 1, y: 1 })
    const typing = bridge.execute({ type: 'type', text: 'long text' })
    const shotErr = shot.catch((e) => e)
    const clickErr = click.catch((e) => e)
    const typeErr = typing.catch((e) => e)

    await vi.advanceTimersByTimeAsync(10000)
    expect(await shotErr).toMatchObject({ code: 'E_AGENT_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(5000)
    expect(await clickErr).toMatchObject({ code: 'E_AGENT_TIMEOUT' })

    let typeSettled = false
    typeErr.then(() => (typeSettled = true))
    await vi.advanceTimersByTimeAsync(44999)
    expect(typeSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await typeErr).toMatchObject({ code: 'E_AGENT_TIMEOUT' })
    bridge.stop()
  })

  it('clears the call timer when a response arrives', async () => {
    vi.useFakeTimers()
    const { bridge, procs } = setup()
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    expect(vi.getTimerCount()).toBe(0)
    const pending = bridge.activeWindow()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    procs[0].reply(procs[0].last('active_window')!.id, { title: 'Notepad' })
    await expect(pending).resolves.toBe('Notepad')
    expect(vi.getTimerCount()).toBe(0)
    bridge.stop()
  })
})
