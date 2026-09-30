import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import type { ChildProcess } from 'child_process'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, AgentError, SpawnFn } from '../src/main/agent-bridge'

type Msg = { id: number; cmd: string; [k: string]: unknown }

class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  pid: number | undefined = 1234
  received: Msg[] = []
  autoReply: (msg: Msg) => boolean = (m) => m.cmd === 'ping'
  killed = false

  constructor() {
    super()
    this.stdin = new Writable({
      write: (chunk, _enc, cb): void => {
        for (const line of chunk.toString().split('\n')) {
          if (!line) continue
          const msg = JSON.parse(line) as Msg
          this.received.push(msg)
          if (this.autoReply(msg)) queueMicrotask(() => this.reply(msg.id, 'ok'))
        }
        cb()
      }
    })
  }

  send(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
  }

  reply(id: number, result: unknown): void {
    this.send({ id, result })
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

function setup(opts: { initState?: () => Promise<void> } = {}): {
  bridge: AgentBridge
  procs: FakeProc[]
  spawnFn: ReturnType<typeof vi.fn>
} {
  const procs: FakeProc[] = []
  const spawnFn = vi.fn(() => {
    const p = new FakeProc()
    procs.push(p)
    return p as unknown as ChildProcess
  })
  const bridge = new AgentBridge({
    spawnFn: spawnFn as unknown as SpawnFn,
    initState: opts.initState
  })
  return { bridge, procs, spawnFn }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

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

  it('pings on start and resolves', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    expect(procs).toHaveLength(1)
    expect(procs[0].received[0].cmd).toBe('ping')
    bridge.stop()
  })

  it('decodes a multibyte UTF-8 char split across chunks', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const p = procs[0]
    const pending = bridge.activeWindow()
    await flush()
    const id = p.last('active_window')!.id
    const bytes = Buffer.from(JSON.stringify({ id, result: 'café \u{1F600}' }) + '\n', 'utf8')
    const eAt = bytes.indexOf(0xc3)
    const emojiAt = bytes.indexOf(0xf0)
    p.stdout.emit('data', bytes.subarray(0, eAt + 1))
    p.stdout.emit('data', bytes.subarray(eAt + 1, emojiAt + 2))
    p.stdout.emit('data', bytes.subarray(emojiAt + 2))
    await expect(pending).resolves.toBe('café \u{1F600}')
    bridge.stop()
  })

  it('handles several lines in one chunk and a line split across chunks', async () => {
    const { bridge, procs } = setup()
    await bridge.start()
    const p = procs[0]
    const events: unknown[] = []
    bridge.onEvent('hotkey-down', (d) => events.push(d))
    const text = '{"event":"hotkey-down","n":1}\n{"event":"hotkey-down","n":2}\n{"event":"hot'
    p.stdout.emit('data', Buffer.from(text))
    expect(events).toHaveLength(2)
    p.stdout.emit('data', Buffer.from('key-down","n":3}\n'))
    expect(events).toHaveLength(3)
    bridge.stop()
  })

  it('rejects pending calls with E_AGENT_EXIT on exit and clears their timers', async () => {
    vi.useFakeTimers()
    const { bridge, procs } = setup()
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    const p = procs[0]
    const a = bridge.screenshot()
    const b = bridge.execute({ type: 'type', text: 'hi' })
    await vi.advanceTimersByTimeAsync(0)
    const timersBefore = vi.getTimerCount()
    p.crash(1)
    await expect(a).rejects.toMatchObject({ code: 'E_AGENT_EXIT' })
    await expect(b).rejects.toBeInstanceOf(AgentError)
    // two call timers gone, one restart timer added
    expect(vi.getTimerCount()).toBe(timersBefore - 2 + 1)
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
    await expect(bridge.screenshot()).rejects.toMatchObject({ code: 'E_AGENT_NOT_RUNNING' })
  })

  it('restarts with backoff and re-runs the init hook', async () => {
    vi.useFakeTimers()
    const initState = vi.fn(async () => {})
    const { bridge, procs, spawnFn } = setup({ initState })
    const down = vi.fn()
    const ready = vi.fn()
    bridge.onEvent('agent-down', down)
    bridge.onEvent('agent-ready', ready)
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    expect(initState).toHaveBeenCalledTimes(1)

    procs[0].crash(1)
    expect(down).toHaveBeenLastCalledWith(
      expect.objectContaining({ willRestart: true, restartInMs: 500 })
    )
    await vi.advanceTimersByTimeAsync(499)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(initState).toHaveBeenCalledTimes(2)
    expect(ready).toHaveBeenCalledTimes(2)

    procs[1].crash(1)
    expect(down).toHaveBeenLastCalledWith(expect.objectContaining({ restartInMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(spawnFn).toHaveBeenCalledTimes(3)
    expect(initState).toHaveBeenCalledTimes(3)
    bridge.stop()
  })

  it('init hook can re-send state through the bridge after restart', async () => {
    vi.useFakeTimers()
    let bridgeRef: AgentBridge | null = null
    const initState = async (): Promise<void> => {
      await bridgeRef!.setHotkey('Ctrl+Shift+Space')
    }
    const { bridge, procs } = setup({ initState })
    bridgeRef = bridge
    for (const p of procs) p.autoReply = () => true
    const origPush = procs.push.bind(procs)
    procs.push = (...items: FakeProc[]): number => {
      items.forEach((p) => (p.autoReply = () => true))
      return origPush(...items)
    }
    const started = bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    procs[0].crash(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(procs[1].received.map((m) => m.cmd)).toEqual(['ping', 'set_hotkey'])
    expect(procs[1].last('set_hotkey')!.combo).toBe('Ctrl+Shift+Space')
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
      procs[i].crash(1)
      await vi.advanceTimersByTimeAsync(10000)
    }
    expect(spawnFn).toHaveBeenCalledTimes(6)
    procs[5].crash(1)
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
    await expect(bridge.screenshot()).rejects.toMatchObject({ code: 'E_AGENT_EPIPE' })
    bridge.stop()
  })

  it('rejects start() and emits agent-down on spawn error', async () => {
    vi.useFakeTimers()
    const { bridge, procs } = setup()
    const down = vi.fn()
    bridge.onEvent('agent-down', down)
    const started = bridge.start()
    const p = procs[0]
    p.pid = undefined
    p.emit('error', new Error('spawn ENOENT'))
    await expect(started).rejects.toMatchObject({ code: 'E_AGENT_EXIT' })
    expect(down).toHaveBeenCalledWith(expect.objectContaining({ reason: 'spawn-error' }))
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
    procs[0].send({ event: 'hotkey-up' })
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

    const shot = bridge.screenshot()
    const click = bridge.execute({ type: 'click', x: 1, y: 1 })
    const typing = bridge.execute({ type: 'type', text: 'long text' })
    const shotErr = shot.catch((e) => e)
    const clickErr = click.catch((e) => e)
    const typeErr = typing.catch((e) => e)

    await vi.advanceTimersByTimeAsync(5000)
    expect(await shotErr).toMatchObject({ code: 'E_AGENT_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(10000)
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
    procs[0].reply(procs[0].last('active_window')!.id, 'Notepad')
    await expect(pending).resolves.toBe('Notepad')
    expect(vi.getTimerCount()).toBe(0)
    bridge.stop()
  })
})
