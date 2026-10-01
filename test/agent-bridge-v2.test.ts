import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, AgentError, type SpawnFn } from '../src/main/agent/bridge'
import * as cmds from '../src/main/agent/commands'
import {
  agentSubscriptions,
  buildAgentInitState,
  type AgentInitArgs
} from '../src/main/agent/state'
import { FAKE_PATHS, FakeChild, flushMicrotasks as flush } from './helpers/fake-child'
import { makeConfig } from './helpers/fixtures'

const READY = {
  v: 2,
  event: 'ready',
  data: { impl: 'native', version: '0.2.0', capabilities: ['hotkey', 'input', 'capture', 'ocr'] }
}

function setup(opts: { initArgs?: () => AgentInitArgs } = {}): {
  bridge: AgentBridge
  procs: FakeChild[]
} {
  const procs: FakeChild[] = []
  const spawnFn: SpawnFn = () => {
    const p = new FakeChild({ autoReady: false })
    queueMicrotask(() => p.emitLine(READY))
    procs.push(p)
    return p.asChildProcess()
  }
  const bridge = new AgentBridge({ spawnFn, paths: FAKE_PATHS, ...opts })
  return { bridge, procs }
}

const INIT: AgentInitArgs = buildAgentInitState(
  makeConfig({ dictation: { enabled: true, hotkey: 'Ctrl+Shift+D' } })
)

describe('AgentBridge protocol v2', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stores impl, version and capabilities from the ready event', async () => {
    const ready = vi.fn()
    const { bridge, procs } = setup()
    bridge.onEvent('agent-ready', ready)
    await bridge.start()
    expect(bridge.impl).toBe('native')
    expect(bridge.version).toBe('0.2.0')
    expect(bridge.capabilities).toEqual(['hotkey', 'input', 'capture', 'ocr'])
    expect(bridge.hasCapability('uia')).toBe(false)
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ impl: 'native' }))

    procs[0].respondTo('set_hotkey', {})
    await bridge.setHotkey('F9')
    expect(procs[0].last('set_hotkey')).toEqual({
      v: 2,
      id: expect.any(Number),
      cmd: 'set_hotkey',
      args: { combo: 'F9' }
    })
    bridge.stop()
  })

  it('sends init with the provided state after ready, before agent-ready', async () => {
    const { bridge, procs } = setup({ initArgs: () => INIT })
    let initBeforeReady = false
    bridge.onEvent('agent-ready', () => (initBeforeReady = !!procs[0].last('init')))
    await bridge.start()
    expect(procs[0].last('init')).toMatchObject({ v: 2, cmd: 'init', args: INIT })
    expect(initBeforeReady).toBe(true)
    bridge.stop()
  })

  it('still reports ready when init fails', async () => {
    const { bridge, procs } = setup({ initArgs: () => INIT })
    const ready = vi.fn()
    bridge.onEvent('agent-ready', ready)
    const started = bridge.start()
    await flush()
    procs[0].replyError(procs[0].last('init')!.id, 'E_INVALID', 'bad hotkey')
    await started
    expect(ready).toHaveBeenCalledTimes(1)
    bridge.stop()
  })

  it('re-sends init after a restart', async () => {
    vi.useFakeTimers()
    const initArgs = vi.fn(() => INIT)
    const { bridge, procs } = setup({ initArgs })
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    expect(procs[0].last('init')).toBeDefined()

    procs[0].emitExit(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(procs).toHaveLength(2)
    expect(initArgs).toHaveBeenCalledTimes(2)
    expect(procs[1].last('init')).toMatchObject({ v: 2, cmd: 'init', args: INIT })
    bridge.stop()
  })

  it('passes event data unwrapped', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const got = vi.fn()
    bridge.onEvent('dwell-trigger', got)
    procs[0].emitLine({ v: 2, event: 'dwell-trigger', data: { x: 3, y: 4 } })
    expect(got).toHaveBeenCalledWith({ x: 3, y: 4 })
    bridge.stop()
  })

  it('maps a v2 error object to AgentError with its code', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const pending = bridge.request('focus_window', { hwnd: 1 })
    await flush()
    const id = procs[0].last('focus_window')!.id
    procs[0].replyError(id, 'E_NOT_FOUND', 'no window')
    const err = await pending.catch((e) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toMatchObject({ code: 'E_NOT_FOUND', message: 'no window' })
    bridge.stop()
  })

  it('sends cancel as {v:2,id,cmd:"cancel",args:{target}}', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    await cmds.cancel(bridge, 42)
    expect(procs[0].last('cancel')).toEqual({
      v: 2,
      id: expect.any(Number),
      cmd: 'cancel',
      args: { target: 42 }
    })
    bridge.stop()
  })

  it('aborting a request rejects E_CANCELLED and cancels it on the agent', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const ac = new AbortController()
    const pending = cmds.input(bridge, [{ t: 'type', text: 'hello' }], { signal: ac.signal })
    await flush()
    const id = procs[0].last('input')!.id
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'E_CANCELLED' })
    expect(procs[0].last('cancel')).toMatchObject({ args: { target: id } })
    bridge.stop()
  })

  it('activeWindow() returns the title', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    procs[0].respondTo('active_window', { title: 'Inbox - Gmail', pid: 7 })
    await expect(bridge.activeWindow()).resolves.toBe('Inbox - Gmail')
    bridge.stop()
  })
})

describe('agent commands', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects commands missing from the capabilities without sending them', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    await expect(cmds.uiaSnapshot(bridge)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(cmds.announce(bridge, 'x')).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect(procs[0].last('uia_snapshot')).toBeUndefined()
    procs[0].respondTo('ocr', { words: [], lines: [] })
    await expect(cmds.ocr(bridge, { frameId: 'f1' })).resolves.toEqual({ words: [], lines: [] })
    bridge.stop()
  })

  it('passes capture args through', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const frames = [{ id: 'f1', width: 10, height: 10, scale: 2, mime: 'image/jpeg', data: 'x' }]
    procs[0].respondTo('capture', { frames })
    await expect(cmds.capture(bridge, { monitor: 'foreground', maxWidth: 1280 })).resolves.toEqual({
      frames
    })
    expect(procs[0].last('capture')!.args).toEqual({ monitor: 'foreground', maxWidth: 1280 })
    bridge.stop()
  })

  it('active_window and ping return the agent result', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const info = { hwnd: 5, title: 'Notepad', process: 'notepad.exe', monitor: 1 }
    procs[0].respondTo('active_window', info)
    await expect(cmds.activeWindow(bridge)).resolves.toEqual(info)
    await expect(cmds.ping(bridge)).resolves.toEqual({ t: 1 })
    bridge.stop()
  })
})

describe('buildAgentInitState', () => {
  it('builds init args from config', () => {
    const cfg = makeConfig({
      hotkey: 'Alt+B',
      dictation: { enabled: false },
      dwellClick: { enabled: true, dwellMs: 900, cooldownMs: 2000 }
    })
    const init = buildAgentInitState(cfg, { scale: 1.5, logLevel: 'debug' })
    expect(init).toMatchObject({
      hotkey: 'Alt+B',
      dictationHotkey: '',
      dwell: { enabled: true, ms: 900, cooldownMs: 2000, clickType: 'left' },
      subscriptions: [],
      logLevel: 'debug'
    })
    expect(init).not.toHaveProperty('wake')
    // The move tolerance goes out in physical px.
    expect(init.dwell.moveTolerancePx).toBe(
      Math.round(buildAgentInitState(cfg).dwell.moveTolerancePx * 1.5)
    )
  })

  it('subscribes to mouse-moved for guide auto-dismiss and focus-changed when wanted', () => {
    expect(buildAgentInitState(makeConfig()).subscriptions).toEqual([])
    const cfg = makeConfig({ guideAutoDismissOnMove: true })
    expect(buildAgentInitState(cfg, { focusEvents: true }).subscriptions).toEqual([
      'mouse-moved',
      'focus-changed'
    ])
    expect(agentSubscriptions(cfg)).toEqual(['mouse-moved'])
  })

  it('binds the dictation hotkey only when enabled and distinct from the main one', () => {
    const on = { enabled: true, hotkey: 'Ctrl+Shift+D' }
    const hotkey = 'Ctrl+Shift+Space'
    expect(buildAgentInitState(makeConfig({ hotkey, dictation: on })).dictationHotkey).toBe(
      'Ctrl+Shift+D'
    )
    expect(
      buildAgentInitState(makeConfig({ hotkey, dictation: { ...on, enabled: false } }))
        .dictationHotkey
    ).toBe('')
    expect(
      buildAgentInitState(makeConfig({ hotkey, dictation: { ...on, hotkey: 'ctrl+shift+space' } }))
        .dictationHotkey
    ).toBe('')
  })
})
