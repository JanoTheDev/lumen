import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge, type SpawnFn } from '../src/main/agent/bridge'
import {
  ImplSelector,
  REQUIRED_NATIVE_CAPABILITIES,
  missingCapabilities,
  nativeCandidates,
  nativeLaunch,
  pythonLaunch,
  type AgentImplPref,
  type AgentPathEnv
} from '../src/main/agent/impl'
import { FakeChild, flushMicrotasks } from './helpers/fake-child'

const DEV_NATIVE = join('/app', 'native', 'target', 'release', 'lumen-native.exe')
const DEV_FASTREL = join('/app', 'native', 'target', 'fastrel', 'lumen-native.exe')
const PKG_NATIVE = join('/res', 'native', 'lumen-native.exe')
const PKG_FROZEN = join('/res', 'agent', 'lumen-agent.exe')
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
  it('dev: release then fastrel native, venv python', () => {
    expect(nativeCandidates(env([]))).toEqual([DEV_NATIVE, DEV_FASTREL])
    expect(nativeLaunch(env([DEV_FASTREL]))?.command).toBe(DEV_FASTREL)
    expect(nativeLaunch(env([DEV_NATIVE, DEV_FASTREL]))).toMatchObject({
      impl: 'native',
      command: DEV_NATIVE,
      args: ['--protocol', '2']
    })
    expect(nativeLaunch(env([]))).toBeNull()
    const py = pythonLaunch(env([]))
    expect(py.command).toBe(join('/app', 'agent', '.venv', 'Scripts', 'python.exe'))
    expect(py.args).toEqual([join('/app', 'agent', 'main.py')])
    expect(py.cwd).toBe(join('/app', 'agent'))
    expect(py.env).toMatchObject({ PYTHONUTF8: '1' })
  })

  it('packaged: resources/native and the frozen python agent', () => {
    const pkg = { dev: false }
    expect(nativeCandidates(env([], pkg))).toEqual([PKG_NATIVE])
    expect(nativeLaunch(env([PKG_NATIVE], pkg))?.command).toBe(PKG_NATIVE)
    expect(pythonLaunch(env([PKG_FROZEN], pkg))).toMatchObject({ command: PKG_FROZEN, args: [] })
    // No frozen exe shipped: the bundled venv.
    expect(pythonLaunch(env([], pkg)).command).toBe(
      join('/res', 'agent', '.venv', 'Scripts', 'python.exe')
    )
  })

  it('no native agent off Windows', () => {
    expect(nativeLaunch(env([DEV_NATIVE], { platform: 'linux' }))).toBeNull()
  })

  it('missing capabilities', () => {
    expect(missingCapabilities(ALL_CAPS)).toEqual([])
    expect(missingCapabilities(['hotkey', 'input'])).toContain('execute')
  })
})

describe('ImplSelector', () => {
  const make = (
    pref: AgentImplPref,
    files: string[],
    clock = { t: 0 }
  ): { sel: ImplSelector; clock: { t: number } } => ({
    sel: new ImplSelector(
      () => pref,
      () => env(files),
      () => clock.t
    ),
    clock
  })

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('python always runs python', () => {
    expect(make('python', [DEV_NATIVE]).sel.choose().impl).toBe('python')
  })

  it('auto picks native when the exe exists, else python', () => {
    expect(make('auto', [DEV_NATIVE]).sel.choose().impl).toBe('native')
    expect(make('auto', []).sel.choose().impl).toBe('python')
    expect(make('native', []).sel.choose().impl).toBe('python')
  })

  it('auto drops native when capabilities fall short; explicit native keeps it', () => {
    const { sel } = make('auto', [DEV_NATIVE])
    const spec = sel.choose()
    expect(sel.check(spec, ALL_CAPS)).toBeNull()
    expect(sel.check(spec, ['hotkey'])).toMatch(/lacks .*execute/)
    const forced = make('native', [DEV_NATIVE]).sel
    expect(forced.check(forced.choose(), ['hotkey'])).toBeNull()
  })

  it('three native crashes within 60 s fall back for the session', () => {
    const { sel, clock } = make('native', [DEV_NATIVE])
    const spec = sel.choose()
    expect(sel.crashed(spec)).toBe(false)
    clock.t = 30000
    expect(sel.crashed(spec)).toBe(false)
    clock.t = 59000
    expect(sel.crashed(spec)).toBe(true)
    expect(sel.fallenBack).toMatch(/crashed 3 times/)
    expect(sel.choose().impl).toBe('python')
  })

  it('crashes spread over more than 60 s do not count together', () => {
    const { sel, clock } = make('native', [DEV_NATIVE])
    const spec = sel.choose()
    sel.crashed(spec)
    clock.t = 40000
    sel.crashed(spec)
    clock.t = 70000
    expect(sel.crashed(spec)).toBe(false)
    expect(sel.choose().impl).toBe('native')
  })

  it('python crashes never count', () => {
    const { sel } = make('auto', [])
    const spec = sel.choose()
    for (let i = 0; i < 5; i++) expect(sel.crashed(spec)).toBe(false)
    expect(sel.fallenBack).toBeNull()
  })
})

describe('AgentBridge impl selection', () => {
  interface Spawned {
    command: string
    child: FakeChild
  }

  function harness(
    pref: AgentImplPref,
    nativeCaps: string[] | null
  ): { bridge: AgentBridge; spawned: Spawned[]; events: Record<string, unknown>[] } {
    const spawned: Spawned[] = []
    const spawnFn: SpawnFn = (command) => {
      const native = command === DEV_NATIVE
      const child = new FakeChild({ framing: native ? 'v2' : 'v1', autoReady: false })
      if (native && nativeCaps) {
        queueMicrotask(() =>
          child.emitLine({
            v: 2,
            event: 'ready',
            data: { impl: 'native', version: '0.1.0', capabilities: nativeCaps }
          })
        )
      }
      spawned.push({ command, child })
      return child.asChildProcess()
    }
    const bridge = new AgentBridge({
      spawnFn,
      impl: () => pref,
      paths: env([DEV_NATIVE]),
      restart: { baseMs: 10, maxMs: 10, maxRestarts: 10 }
    })
    const events: Record<string, unknown>[] = []
    bridge.onEvent('agent-impl-fallback', (d) => events.push(d ?? {}))
    return { bridge, spawned, events }
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('auto runs native when it advertises every required capability', async () => {
    const { bridge, spawned } = harness('auto', ALL_CAPS)
    await bridge.start()
    expect(spawned.map((s) => s.command)).toEqual([DEV_NATIVE])
    expect(bridge.impl).toBe('native')
    expect(bridge.protocol).toBe(2)
    bridge.stop()
  })

  it('auto swaps a native agent lacking capabilities for python', async () => {
    const { bridge, spawned, events } = harness('auto', ['hotkey', 'input', 'capture'])
    await bridge.start()
    expect(spawned).toHaveLength(2)
    expect(spawned[0].child.killed).toBe(true)
    expect(spawned[1].command).toMatch(/python\.exe$/)
    expect(bridge.protocol).toBe(1)
    expect(bridge.implFallback).toMatch(/lacks/)
    expect(events[0]).toMatchObject({ from: 'native', to: 'python' })
    bridge.stop()
  })

  it('auto falls back to python when native never becomes ready', async () => {
    const { bridge, spawned } = harness('auto', null)
    // A v1-framed ping to a v2 agent that never sent ready is answered with an error.
    await bridge.start()
    await flushMicrotasks()
    expect(spawned.map((s) => s.command)).toEqual([DEV_NATIVE, expect.stringMatching(/python/)])
    expect(bridge.implFallback).toMatch(/failed to start/)
    bridge.stop()
  })

  it('native crashing three times within a minute restarts as python', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, spawned, events } = harness('native', ['hotkey'])
      await bridge.start()
      for (let i = 0; i < 3; i++) {
        expect(spawned[spawned.length - 1].command).toBe(DEV_NATIVE)
        spawned[spawned.length - 1].child.emitExit(3)
        await vi.advanceTimersByTimeAsync(20)
      }
      expect(spawned).toHaveLength(4)
      expect(spawned[3].command).toMatch(/python\.exe$/)
      expect(bridge.implFallback).toMatch(/crashed 3 times/)
      expect(events).toHaveLength(1)
      bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('python preference never spawns native', async () => {
    const { bridge, spawned } = harness('python', ALL_CAPS)
    await bridge.start()
    expect(spawned.map((s) => s.command)).toEqual([
      join('/app', 'agent', '.venv', 'Scripts', 'python.exe')
    ])
    bridge.stop()
  })
})
