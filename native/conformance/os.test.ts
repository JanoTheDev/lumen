// capture, active_window, hotkey parser, dwell config, announce.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent } from './agent'

let agent: Agent

beforeAll(async () => {
  agent = await Agent.start()
})

afterAll(async () => {
  await agent?.close()
})

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function isRect(r: unknown): r is Rect {
  const o = r as Rect
  return !!o && ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(o[k as keyof Rect]))
}

function expectMonitor(m: Record<string, unknown>): void {
  expect(Number.isInteger(m.id)).toBe(true)
  expect(m.device).toMatch(/^\\\\\.\\DISPLAY\d+/)
  expect(isRect(m.rect)).toBe(true)
  expect(isRect(m.workArea)).toBe(true)
  expect(typeof m.dpi).toBe('number')
  expect(m.scale).toBeCloseTo((m.dpi as number) / 96, 3)
  expect(typeof m.primary).toBe('boolean')
}

describe('capture', () => {
  it('captures the primary monitor with geometry', async (ctx) => {
    if (!agent.has('capture')) ctx.skip()
    const r = await agent.ok<{ frames: Record<string, unknown>[] }>('capture', {
      monitor: 'primary',
      maxWidth: 1280
    })
    expect(r.frames).toHaveLength(1)
    const f = r.frames[0]
    expect(typeof f.id).toBe('string')
    expect(f.mime).toBe('image/jpeg')
    expect(f.width).toBeLessThanOrEqual(1280)
    expect(f.height).toBeGreaterThan(0)
    const mon = f.monitor as Record<string, unknown>
    expectMonitor(mon)
    expect(mon.primary).toBe(true)
    expect(f.scale).toBeCloseTo((mon.rect as Rect).w / (f.width as number), 2)
    const jpeg = Buffer.from(f.data as string, 'base64')
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
  })

  it('captures every monitor with "all" and ids are sorted by x', async (ctx) => {
    if (!agent.has('capture')) ctx.skip()
    const r = await agent.ok<{ frames: { monitor: { id: number; rect: Rect } }[] }>('capture', {
      monitor: 'all',
      maxWidth: 320
    })
    expect(r.frames.length).toBeGreaterThan(0)
    const xs = r.frames.map((f) => f.monitor.rect.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    expect(r.frames.map((f) => f.monitor.id)).toEqual(r.frames.map((_, i) => i))
  })

  it('captures a region at full scale', async (ctx) => {
    if (!agent.has('capture')) ctx.skip()
    const all = await agent.ok<{ frames: { monitor: { rect: Rect } }[] }>('capture', {
      monitor: 'primary',
      maxWidth: 64
    })
    const m = all.frames[0].monitor.rect
    const region = { x: m.x + 10, y: m.y + 10, w: 200, h: 100 }
    const r = await agent.ok<{ frames: Record<string, unknown>[] }>('capture', {
      region,
      maxWidth: 1280
    })
    const f = r.frames[0]
    expect(f.width).toBe(200)
    expect(f.height).toBe(100)
    expect(f.scale).toBe(1)
    expect(f.region).toEqual(region)
  })

  it('rejects bad monitor and region args', async (ctx) => {
    if (!agent.has('capture')) ctx.skip()
    expect((await agent.request('capture', { monitor: 99 })).error?.code).toBe('E_NOT_FOUND')
    expect((await agent.request('capture', { monitor: 'left' })).error?.code).toBe('E_INVALID')
    const bad = await agent.request('capture', { region: { x: 0, y: 0, w: 0, h: 10 } })
    expect(bad.error?.code).toBe('E_INVALID')
    const off = await agent.request('capture', { region: { x: -100000, y: -100000, w: 10, h: 10 } })
    expect(off.error?.code).toBe('E_INVALID')
  })
})

describe('active_window', () => {
  it('returns the C2 window record', async () => {
    const w = await agent.ok('active_window')
    expect(Number.isInteger(w.hwnd)).toBe(true)
    expect(typeof w.title).toBe('string')
    expect(typeof w.process).toBe('string')
    expect(typeof w.exe).toBe('string')
    expect(Number.isInteger(w.pid)).toBe(true)
    expect(isRect(w.rect)).toBe(true)
    expect(Number.isInteger(w.monitor)).toBe(true)
    expect(typeof w.isBrowser).toBe('boolean')
    if (w.process) expect(w.process).toBe((w.process as string).toLowerCase())
  })
})

describe('hotkey', () => {
  const valid = [
    'Ctrl+Shift+Space',
    'CommandOrControl+Alt+K',
    'CmdOrCtrl+F12',
    'Alt+Return',
    'Shift+F24',
    'Ctrl+Plus',
    'Ctrl++',
    'Super+Up',
    'Ctrl+num5',
    'Ctrl+numadd',
    'Alt+PageDown',
    'Ctrl+Escape',
    'Ctrl+/',
    'F9'
  ]
  const invalid = ['Ctrl+Bogus', 'Ctrl+Shift', 'Ctrl+A+B', 'Ctrl++Shift', '+Ctrl', 'Ctrl+F25']

  it('accepts Electron accelerators', async (ctx) => {
    if (!agent.has('hotkey')) ctx.skip()
    for (const combo of valid) {
      const f = await agent.request('set_hotkey', { combo })
      expect(f.ok, combo).toBe(true)
    }
    await agent.ok('set_hotkey', { combo: '' })
  })

  it('rejects bad accelerators with E_INVALID', async (ctx) => {
    if (!agent.has('hotkey')) ctx.skip()
    for (const combo of invalid) {
      const f = await agent.request('set_hotkey', { combo })
      expect(f.error?.code, combo).toBe('E_INVALID')
    }
    expect((await agent.request('set_hotkey', {})).error?.code).toBe('E_INVALID')
  })

  it('dictation hotkey must differ from the assistant one', async (ctx) => {
    if (!agent.has('dictation-hotkey')) ctx.skip()
    await agent.ok('set_hotkey', { combo: 'Ctrl+Alt+F23' })
    const same = await agent.request('set_dictation_hotkey', { combo: 'ctrl+alt+f23' })
    expect(same.error?.code).toBe('E_INVALID')
    await agent.ok('set_dictation_hotkey', { combo: 'Ctrl+Alt+F22' })
    await agent.ok('set_dictation_hotkey', { combo: '' })
    await agent.ok('set_hotkey', { combo: '' })
  })
})

describe('hotkey (injected)', () => {
  it('fires hotkey-down/up for injected keys with --accept-injected', async (ctx) => {
    if (!(agent.has('hotkey') && agent.has('input') && agent.ready.impl === 'native')) ctx.skip()
    const a = await Agent.start('--accept-injected')
    try {
      await a.ok('set_hotkey', { combo: 'Shift+F23' })
      const from = a.frames.length
      await a.ok('input', { steps: [{ t: 'keys', combo: 'shift+f23' }], allowTerminal: true })
      const down = await a.waitFor((f) => f.event === 'hotkey-down', 5000, from)
      const up = await a.waitFor((f) => f.event === 'hotkey-up', 5000, from)
      expect(down.data).toEqual({})
      expect(a.frames.indexOf(up)).toBeGreaterThan(a.frames.indexOf(down))
    } finally {
      await a.close()
    }
  })
})

describe('switch keys', () => {
  it('validates names and releases with an empty list', async (ctx) => {
    if (!agent.has('switch')) ctx.skip()
    expect(await agent.ok('switch_keys', { keys: ['Space', 'F8'], mouse: ['x1'] })).toEqual({
      keys: ['Space', 'F8'],
      mouse: ['x1']
    })
    expect(await agent.ok('switch_keys', { keys: [] })).toEqual({ keys: [], mouse: [] })
    expect((await agent.request('switch_keys', { keys: ['Bogus'] })).error?.code).toBe('E_INVALID')
    expect((await agent.request('switch_keys', { keys: [], mouse: ['wheel'] })).error?.code).toBe(
      'E_INVALID'
    )
    expect((await agent.request('switch_keys', { keys: 'Space' })).error?.code).toBe('E_INVALID')
  })

  it('injected keys are neither suppressed nor reported (switch, key-combo)', async (ctx) => {
    if (!(agent.has('switch') && agent.has('key-combo') && agent.has('input'))) ctx.skip()
    await agent.ok('switch_keys', { keys: ['F23'] })
    await agent.ok('subscribe', { events: ['key-combo'], enabled: true })
    try {
      const from = agent.frames.length
      await agent.ok('input', { steps: [{ t: 'keys', combo: 'f23' }], allowTerminal: true })
      await agent.ok('input', { steps: [{ t: 'keys', combo: 'ctrl+f23' }], allowTerminal: true })
      await new Promise((r) => setTimeout(r, 400))
      const seen = agent.frames
        .slice(from)
        .filter((f) => f.event === 'switch' || f.event === 'key-combo')
      expect(seen).toEqual([])
    } finally {
      await agent.ok('subscribe', { events: ['key-combo'], enabled: false })
      await agent.ok('switch_keys', { keys: [] })
    }
  })
})

describe('dwell', () => {
  it('dwell_config returns the effective config', async (ctx) => {
    if (!agent.has('dwell')) ctx.skip()
    const c = await agent.ok('dwell_config', {
      enabled: false,
      ms: 900,
      cooldownMs: 700,
      clickType: 'right',
      smoothing: 0.4
    })
    expect(c).toMatchObject({
      enabled: false,
      ms: 900,
      cooldownMs: 700,
      clickType: 'right',
      maxRepeats: 0
    })
    if (agent.ready.impl === 'native') expect(c.smoothing).toBe(0.4)
    const p = await agent.ok('dwell_pause')
    expect(p).toEqual({ paused: true })
    expect(await agent.ok('dwell_resume')).toEqual({ paused: false })
  })
})

describe('dwell (live)', () => {
  it('a resting cursor triggers exactly once, after the input grace period', async (ctx) => {
    if (!(agent.has('dwell') && agent.has('input'))) ctx.skip()
    const from = agent.frames.length
    await agent.ok('input', { steps: [{ t: 'move', x: 400, y: 300 }] })
    const t0 = Date.now()
    await agent.ok('dwell_config', { enabled: true, ms: 300, cooldownMs: 300, clickType: 'left' })
    try {
      const trig = await agent.waitFor((f) => f.event === 'dwell-trigger', 5000, from)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
      expect(trig.data).toMatchObject({ x: 400, y: 300, clickType: 'left' })
      expect(typeof trig.data?.lx).toBe('number')
      expect(Number.isInteger(trig.data?.monitorId)).toBe(true)
      await new Promise((r) => setTimeout(r, 1200))
      expect(agent.frames.slice(from).filter((f) => f.event === 'dwell-trigger')).toHaveLength(1)
      const prog = agent.frames
        .slice(from)
        .find((f) => f.event === 'dwell-progress' && f.data?.active)
      expect(prog?.data?.progress).toBeGreaterThan(0)
    } finally {
      await agent.ok('dwell_config', { enabled: false })
    }
  })
})

describe('announce', () => {
  it('validates and reports whether it spoke', async (ctx) => {
    if (!agent.has('announce')) ctx.skip()
    expect((await agent.request('announce', { text: '' })).error?.code).toBe('E_INVALID')
    expect((await agent.request('announce', { text: 'x', priority: 'loud' })).error?.code).toBe(
      'E_INVALID'
    )
    const r = await agent.ok('announce', { text: 'Conformance check', priority: 'polite' })
    expect(typeof r.spoken).toBe('boolean')
  })
})
