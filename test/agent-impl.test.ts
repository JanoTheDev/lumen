import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, type SpawnFn } from '../src/main/agent/bridge'
import {
  REQUIRED_NATIVE_CAPABILITIES,
  missingCapabilities,
  nativeCandidates,
  nativeLaunch,
  type AgentPathEnv
} from '../src/main/agent/impl'
import { FakeChild, READY_V2, flushMicrotasks } from './helpers/fake-child'

const DEV_NATIVE = join('/app', 'native', 'target', 'release', 'lumen-native.exe')
const DEV_FASTREL = join('/app', 'native', 'target', 'fastrel', 'lumen-native.exe')
const PKG_NATIVE = join('/res', 'native', 'lumen-native.exe')
const ALL_CAPS = [...REQUIRED_NATIVE_CAPABILITIES]

function env(files: string[], over: Partial<AgentPathEnv> = {}): AgentPathEnv {
  return {
    dev: true,
    appPath: '/app',
    resourcesPath: '/res',
    platform: 'win32',
    exists: (p) => files.includes(p),
    ...over
  }
}

describe('agent paths', () => {
  it('dev: release then fastrel', () => {
    expect(nativeCandidates(env([]))).toEqual([DEV_NATIVE, DEV_FASTREL])
    expect(nativeLaunch(env([DEV_FASTREL]))?.command).toBe(DEV_FASTREL)
    expect(nativeLaunch(env([DEV_NATIVE, DEV_FASTREL]))).toEqual({
      command: DEV_NATIVE,
      args: ['--protocol', '2'],
      cwd: join(DEV_NATIVE, '..')
    })
    expect(nativeLaunch(env([]))).toBeNull()
  })

  it('packaged: resources/native', () => {
    const pkg = { dev: false }
    expect(nativeCandidates(env([], pkg))).toEqual([PKG_NATIVE])
    expect(nativeLaunch(env([PKG_NATIVE], pkg))?.command).toBe(PKG_NATIVE)
  })

  it('no native agent off Windows', () => {
    expect(nativeLaunch(env([DEV_NATIVE], { platform: 'linux' }))).toBeNull()
  })

  it('the native agent advertises every capability main needs', () => {
    const src = readFileSync(join(__dirname, '..', 'native', 'src', 'app.rs'), 'utf8')
    const list = /pub const CAPABILITIES: &\[&str\] =\s*&\[([^\]]*)\]/.exec(src)?.[1] ?? ''
    const caps = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(missingCapabilities(caps)).toEqual([])
  })

  it('missing capabilities', () => {
    expect(missingCapabilities(ALL_CAPS)).toEqual([])
    expect(missingCapabilities(['hotkey', 'input'])).toContain('execute')
  })
})

describe('AgentBridge launch', () => {
  let files: string[]

  function harness(opts: { ready?: boolean; caps?: string[] } = {}): {
    bridge: AgentBridge
    spawned: FakeChild[]
    events: Array<[string, Record<string, unknown>]>
  } {
    const spawned: FakeChild[] = []
    const spawnFn: SpawnFn = () => {
      const child = new FakeChild({ autoReady: false })
      if (opts.ready ?? true) {
        const data = { ...READY_V2.data, capabilities: opts.caps ?? ALL_CAPS }
        queueMicrotask(() => child.emitLine({ ...READY_V2, data }))
      }
      spawned.push(child)
      return child.asChildProcess()
    }
    const bridge = new AgentBridge({
      spawnFn,
      // `files` is read on every launch, so a test can remove or restore the exe.
      paths: env([], { exists: (p) => files.includes(p) }),
      readyTimeoutMs: 50,
      restart: { baseMs: 10, maxMs: 10, maxRestarts: 10 }
    })
    const events: Array<[string, Record<string, unknown>]> = []
    for (const e of ['agent-ready', 'agent-down'])
      bridge.onEvent(e, (d) => events.push([e, d ?? {}]))
    return { bridge, spawned, events }
  }

  beforeEach(() => {
    files = [DEV_NATIVE]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs the native exe with --protocol 2 and reports it', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      const c = new FakeChild()
      return c.asChildProcess()
    })
    const bridge = new AgentBridge({ spawnFn: spawn, paths: env([DEV_NATIVE]) })
    await bridge.start()
    expect(spawn).toHaveBeenCalledWith(
      DEV_NATIVE,
      ['--protocol', '2'],
      expect.objectContaining({ cwd: join(DEV_NATIVE, '..') })
    )
    expect(bridge.impl).toBe('native')
    expect(bridge.lastError).toBeNull()
    bridge.stop()
  })

  it('keeps a ready agent that lacks capabilities and logs them', async () => {
    const { bridge } = harness({ caps: ['hotkey'] })
    await bridge.start()
    expect(bridge.running).toBe(true)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('lacks'),
      expect.stringContaining('execute')
    )
    bridge.stop()
  })

  it('a missing exe rejects start with a clear error and spawns nothing', async () => {
    files = []
    const { bridge, spawned } = harness()
    await expect(bridge.start()).rejects.toMatchObject({ code: 'E_AGENT_MISSING' })
    expect(spawned).toHaveLength(0)
    expect(bridge.lastError).toMatch(/native agent not found/)
  })

  it('keeps retrying on backoff while the exe is missing, then starts', async () => {
    vi.useFakeTimers()
    const { bridge, spawned, events } = harness()
    await bridge.start()
    files = []
    spawned[0].emitExit(1)
    await vi.advanceTimersByTimeAsync(15)
    expect(bridge.lastError).toMatch(/not found/)
    expect(events.filter(([e]) => e === 'agent-down')).toHaveLength(2)
    files = [DEV_NATIVE]
    await vi.advanceTimersByTimeAsync(15)
    expect(spawned).toHaveLength(2)
    expect(bridge.running).toBe(true)
    expect(bridge.lastError).toBeNull()
    bridge.stop()
  })

  it('a handshake timeout kills the child and restarts with backoff', async () => {
    vi.useFakeTimers()
    const { bridge, spawned } = harness({ ready: false })
    const started = bridge.start()
    const rejected = expect(started).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(spawned[0].killed).toBe(true)
    await vi.advanceTimersByTimeAsync(15)
    expect(spawned).toHaveLength(2)
    bridge.stop()
  })

  it('stop() during the handshake rejects that start; a new start is not clobbered', async () => {
    const { bridge, spawned, events } = harness({ ready: false })
    const first = bridge.start()
    const firstDone = first.catch((e) => e)
    bridge.stop()
    expect(await firstDone).toMatchObject({ code: 'E_AGENT_STOPPED' })

    const second = bridge.start()
    await flushMicrotasks()
    spawned[1].emitLine(READY_V2)
    await second
    // The stale launch's exit or rejection must not touch the new child.
    await flushMicrotasks()
    expect(bridge.running).toBe(true)
    expect(spawned[1].killed).toBe(false)
    expect(events.filter(([e]) => e === 'agent-ready')).toHaveLength(1)
    bridge.stop()
  })

  it('start() while a child runs replaces it', async () => {
    const { bridge, spawned } = harness()
    await bridge.start()
    await bridge.start()
    expect(spawned[0].killed).toBe(true)
    await flushMicrotasks()
    expect(bridge.running).toBe(true)
    bridge.stop()
  })
})
