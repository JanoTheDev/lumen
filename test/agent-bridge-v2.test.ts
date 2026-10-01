import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import type { ChildProcess } from 'child_process'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, AgentError, SpawnFn } from '../src/main/agent/bridge'
import * as cmds from '../src/main/agent/commands'
import { buildAgentInitState, type AgentInitArgs } from '../src/main/agent/state'
import type { AppConfig } from '../src/main/config'

type Msg = {
  v?: number
  id: number
  cmd: string
  args?: Record<string, unknown>
  [k: string]: unknown
}

const READY = {
  v: 2,
  event: 'ready',
  data: { impl: 'native', version: '0.2.0', capabilities: ['hotkey', 'input', 'capture', 'ocr'] }
}

class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  pid: number | undefined = 1234
  received: Msg[] = []
  results: Record<string, unknown> = {}
  killed = false
  /** v1: answer unknown commands like the Python agent does. */
  v1Unknown = true

  constructor(public v2: boolean) {
    super()
    this.stdin = new Writable({
      write: (chunk, _enc, cb): void => {
        for (const line of chunk.toString().split('\n')) {
          if (!line) continue
          const msg = JSON.parse(line) as Msg
          this.received.push(msg)
          this.autoReply(msg)
        }
        cb()
      }
    })
    if (v2) queueMicrotask(() => this.send(READY))
  }

  autoReply(msg: Msg): void {
    if (this.v2) {
      // v2 agents answer v1-framed lines with a bad-request error; the bridge must ignore it.
      if (msg.v !== 2) {
        queueMicrotask(() =>
          this.send({
            v: 2,
            id: msg.id,
            ok: false,
            error: { code: 'E_INTERNAL', message: 'bad frame' }
          })
        )
        return
      }
      if (
        msg.cmd in this.results ||
        msg.cmd === 'init' ||
        msg.cmd === 'ping' ||
        msg.cmd === 'cancel'
      ) {
        const result = this.results[msg.cmd] ?? (msg.cmd === 'ping' ? { t: 1 } : {})
        queueMicrotask(() => this.send({ v: 2, id: msg.id, ok: true, result }))
      }
      return
    }
    if (msg.cmd === 'ping') queueMicrotask(() => this.send({ id: msg.id, result: 'pong' }))
    else if (msg.cmd in this.results)
      queueMicrotask(() => this.send({ id: msg.id, result: this.results[msg.cmd] }))
    else if (this.v1Unknown)
      queueMicrotask(() => this.send({ id: msg.id, error: `Unknown command: ${msg.cmd}` }))
  }

  send(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  crash(code = 1): void {
    this.emit('exit', code, null)
  }

  last(cmd: string): Msg | undefined {
    return [...this.received].reverse().find((m) => m.cmd === cmd)
  }
}

function setup(
  v2: boolean,
  opts: { initArgs?: () => AgentInitArgs; initState?: () => Promise<void> } = {}
): { bridge: AgentBridge; procs: FakeProc[]; spawnFn: ReturnType<typeof vi.fn> } {
  const procs: FakeProc[] = []
  const spawnFn = vi.fn(() => {
    const p = new FakeProc(v2)
    procs.push(p)
    return p as unknown as ChildProcess
  })
  const bridge = new AgentBridge({ spawnFn: spawnFn as unknown as SpawnFn, ...opts })
  return { bridge, procs, spawnFn }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const INIT: AgentInitArgs = {
  hotkey: 'Ctrl+Shift+Space',
  dictationHotkey: 'Ctrl+Shift+D',
  wake: { enabled: false, phrase: '', cancelPhrases: [] },
  dwell: { enabled: false, ms: 1400, cooldownMs: 1500 },
  logLevel: 'info'
}

// 1x1 baseline JPEG header (SOI, APP0, SOF0 with 640x360)
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9
]).toString('base64')

describe('AgentBridge protocol v2', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays on v1 framing when the agent sends no ready event', async () => {
    const { bridge, procs } = setup(false)
    await bridge.start()
    expect(bridge.protocol).toBe(1)
    expect(bridge.capabilities).toEqual([])
    expect(procs[0].received[0]).toEqual({ id: 1, cmd: 'ping' })
    procs[0].results.set_hotkey = { ok: true }
    await bridge.setHotkey('F9')
    expect(procs[0].last('set_hotkey')).toMatchObject({ cmd: 'set_hotkey', combo: 'F9' })
    expect(procs[0].last('set_hotkey')).not.toHaveProperty('v')
    bridge.stop()
  })

  it('switches to v2 on the ready event and stores impl, version, capabilities', async () => {
    const ready = vi.fn()
    const { bridge, procs } = setup(true)
    bridge.onEvent('agent-ready', ready)
    await bridge.start()
    expect(bridge.protocol).toBe(2)
    expect(bridge.impl).toBe('native')
    expect(bridge.version).toBe('0.2.0')
    expect(bridge.capabilities).toEqual(['hotkey', 'input', 'capture', 'ocr'])
    expect(bridge.hasCapability('uia')).toBe(false)
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ protocol: 2, impl: 'native' }))

    procs[0].results.set_hotkey = {}
    await bridge.setHotkey('F9')
    expect(procs[0].last('set_hotkey')).toEqual({
      v: 2,
      id: expect.any(Number),
      cmd: 'set_hotkey',
      args: { combo: 'F9' }
    })
    bridge.stop()
  })

  it('sends init with the provided state after ready instead of the v1 hook', async () => {
    const initState = vi.fn(async () => {})
    const { bridge, procs } = setup(true, { initArgs: () => INIT, initState })
    await bridge.start()
    expect(procs[0].last('init')).toMatchObject({ v: 2, cmd: 'init', args: INIT })
    expect(initState).not.toHaveBeenCalled()
    bridge.stop()
  })

  it('runs the v1 initState hook and never sends init on v1', async () => {
    const initState = vi.fn(async () => {})
    const { bridge, procs } = setup(false, { initArgs: () => INIT, initState })
    await bridge.start()
    expect(initState).toHaveBeenCalledTimes(1)
    expect(procs[0].last('init')).toBeUndefined()
    bridge.stop()
  })

  it('re-sends init after a restart on v2', async () => {
    vi.useFakeTimers()
    const initArgs = vi.fn(() => INIT)
    const { bridge, procs } = setup(true, { initArgs })
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    expect(procs[0].last('init')).toBeDefined()

    procs[0].crash(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(procs).toHaveLength(2)
    expect(bridge.protocol).toBe(2)
    expect(initArgs).toHaveBeenCalledTimes(2)
    expect(procs[1].last('init')).toMatchObject({ v: 2, cmd: 'init', args: INIT })
    bridge.stop()
  })

  it('passes event data unwrapped for v2 and without the event key for v1', async () => {
    const v2 = setup(true)
    await v2.bridge.start()
    const got2 = vi.fn()
    v2.bridge.onEvent('dwell-trigger', got2)
    v2.procs[0].send({ v: 2, event: 'dwell-trigger', data: { x: 3, y: 4 } })
    expect(got2).toHaveBeenCalledWith({ x: 3, y: 4 })
    v2.bridge.stop()

    const v1 = setup(false)
    await v1.bridge.start()
    const got1 = vi.fn()
    v1.bridge.onEvent('dwell-trigger', got1)
    v1.procs[0].send({ event: 'dwell-trigger', x: 3, y: 4 })
    expect(got1).toHaveBeenCalledWith({ x: 3, y: 4 })
    v1.bridge.stop()
  })

  it('maps a v2 error object to AgentError with its code', async () => {
    const { bridge, procs } = setup(true)
    await bridge.start()
    const pending = bridge.request('focus_window', { hwnd: 1 })
    await flush()
    const id = procs[0].last('focus_window')!.id
    procs[0].send({ v: 2, id, ok: false, error: { code: 'E_NOT_FOUND', message: 'no window' } })
    const err = await pending.catch((e) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toMatchObject({ code: 'E_NOT_FOUND', message: 'no window' })
    bridge.stop()
  })

  it('sends cancel as {v:2,id,cmd:"cancel",args:{target}}', async () => {
    const { bridge, procs } = setup(true)
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
    const { bridge, procs } = setup(true)
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

  it('translates the legacy bridge helpers to v2 results', async () => {
    const { bridge, procs } = setup(true)
    await bridge.start()
    procs[0].results.active_window = { title: 'Inbox - Gmail', pid: 7 }
    procs[0].results.capture = { frames: [{ id: 'f1', data: 'abc' }] }
    await expect(bridge.activeWindow()).resolves.toBe('Inbox - Gmail')
    await expect(bridge.screenshot()).resolves.toBe('abc')
    expect(procs[0].last('capture')!.args).toEqual({ monitor: 'primary' })
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

  it('rejects v2-only commands with E_UNSUPPORTED on v1', async () => {
    const { bridge, procs } = setup(false)
    await bridge.start()
    const calls = [
      cmds.input(bridge, [{ t: 'wait', ms: 1 }]),
      cmds.announce(bridge, 'hi'),
      cmds.cancel(bridge, 1),
      cmds.init(bridge, INIT)
    ]
    for (const c of calls) await expect(c).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect(procs[0].received.map((m) => m.cmd)).toEqual(['ping'])
    bridge.stop()
  })

  it('tries the read commands on v1 and remembers the ones the agent lacks', async () => {
    const { bridge, procs } = setup(false)
    await bridge.start()
    procs[0].results.ocr = { words: [], lines: [] }
    await expect(cmds.ocr(bridge, { frameId: 'f1' })).resolves.toEqual({ words: [], lines: [] })
    expect(procs[0].last('ocr')).toMatchObject({ cmd: 'ocr', frameId: 'f1' })
    await expect(cmds.uiaSnapshot(bridge)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(cmds.uiaSnapshot(bridge)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect(procs[0].received.filter((m) => m.cmd === 'uia_snapshot')).toHaveLength(1)
    bridge.stop()
  })

  it('uses capture with monitor geometry on a v1 agent that has it', async () => {
    const { bridge, procs } = setup(false)
    await bridge.start()
    const monitor = { id: 1, rect: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1, primary: false }
    const frames = [
      { id: 'f3', monitor, width: 1280, height: 720, scale: 1.5, mime: 'image/jpeg', data: 'x' }
    ]
    procs[0].results.capture = { frames }
    await expect(cmds.capture(bridge, { monitor: 'foreground' })).resolves.toEqual({ frames })
    expect(procs[0].last('capture')).toMatchObject({ monitor: 'foreground' })
    expect(procs[0].last('screenshot')).toBeUndefined()
    bridge.stop()
  })

  it('rejects commands missing from the v2 capabilities', async () => {
    const { bridge, procs } = setup(true)
    await bridge.start()
    await expect(cmds.uiaSnapshot(bridge)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(cmds.announce(bridge, 'x')).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    procs[0].results.ocr = { words: [], lines: [] }
    await expect(cmds.ocr(bridge, { frameId: 'f1' })).resolves.toEqual({ words: [], lines: [] })
    bridge.stop()
  })

  it('maps activeWindow and capture onto v1 commands', async () => {
    const { bridge, procs } = setup(false)
    await bridge.start()
    procs[0].results.active_window = 'Notepad'
    procs[0].results.screenshot = TINY_JPEG
    await expect(cmds.activeWindow(bridge)).resolves.toEqual({ title: 'Notepad' })
    const shot = await cmds.capture(bridge, { monitor: 'all' })
    expect(shot.frames).toHaveLength(1)
    expect(shot.frames[0]).toMatchObject({
      width: 640,
      height: 360,
      mime: 'image/jpeg',
      data: TINY_JPEG
    })
    expect(shot.frames[0].monitor).toBeUndefined()
    await expect(cmds.ping(bridge)).resolves.toEqual({ t: expect.any(Number) })
    bridge.stop()
  })

  it('passes capture args through on v2', async () => {
    const { bridge, procs } = setup(true)
    await bridge.start()
    const frames = [{ id: 'f1', width: 10, height: 10, scale: 2, mime: 'image/jpeg', data: 'x' }]
    procs[0].results.capture = { frames }
    await expect(cmds.capture(bridge, { monitor: 'foreground', maxWidth: 1280 })).resolves.toEqual({
      frames
    })
    expect(procs[0].last('capture')!.args).toEqual({ monitor: 'foreground', maxWidth: 1280 })
    bridge.stop()
  })
})

describe('buildAgentInitState', () => {
  it('builds init args from config', () => {
    const cfg = {
      hotkey: 'Alt+B',
      wakeWord: { enabled: true, phrase: ' hey lumen ' },
      cancelVoice: { enabled: true, phrases: 'stop, cancel\nnever mind,' },
      dwellClick: { enabled: true, dwellMs: 900, cooldownMs: 2000 }
    } as unknown as AppConfig
    expect(buildAgentInitState(cfg)).toEqual({
      hotkey: 'Alt+B',
      dictationHotkey: '',
      wake: { enabled: true, phrase: 'hey lumen', cancelPhrases: ['stop', 'cancel', 'never mind'] },
      dwell: { enabled: true, ms: 900, cooldownMs: 2000 },
      logLevel: 'info'
    })
  })

  it('falls back to safe defaults for missing or malformed fields', () => {
    const cfg = {
      wakeWord: { enabled: true, phrase: '  ' },
      cancelVoice: { enabled: false, phrases: 'stop' },
      dwellClick: { dwellMs: 'x' }
    } as unknown as AppConfig
    expect(buildAgentInitState(cfg, 'debug')).toEqual({
      hotkey: 'Ctrl+Shift+Space',
      dictationHotkey: '',
      wake: { enabled: false, phrase: '', cancelPhrases: [] },
      dwell: { enabled: false, ms: 1400, cooldownMs: 1500 },
      logLevel: 'debug'
    })
    expect(buildAgentInitState(undefined).hotkey).toBe('Ctrl+Shift+Space')
  })

  it('binds the dictation hotkey only when enabled and distinct from the main one', () => {
    const base = { hotkey: 'Ctrl+Shift+Space' }
    const on = { enabled: true, hotkey: 'Ctrl+Shift+D' }
    expect(
      buildAgentInitState({ ...base, dictation: on } as unknown as AppConfig).dictationHotkey
    ).toBe('Ctrl+Shift+D')
    expect(
      buildAgentInitState({ ...base, dictation: { ...on, enabled: false } } as unknown as AppConfig)
        .dictationHotkey
    ).toBe('')
    expect(
      buildAgentInitState({
        ...base,
        dictation: { ...on, hotkey: 'ctrl+shift+space' }
      } as unknown as AppConfig).dictationHotkey
    ).toBe('')
  })
})
