import { describe, expect, it } from 'vitest'
import type { DwellPaletteState, DwellRingData } from '../../src/shared/channels'
import type { ElementNode, InputStep, Point, Rect } from '../../src/shared/types'
import { makeConfig } from '../helpers/fixtures'
import {
  CONFIRM_MS,
  DwellController,
  SCROLL_REACH_PX,
  agentDwellConfig,
  dwellSettings,
  holdDwell,
  inCorner,
  isRiskyName,
  scrollArrowAt,
  setDwellController,
  snapTarget,
  type DwellIo,
  type DwellOverlay,
  type DwellSettings
} from '../../src/main/a11y/dwell'

const BASE: DwellSettings = {
  enabled: true,
  ms: 1000,
  cooldownMs: 1000,
  clickType: 'left',
  sticky: false,
  maxRepeats: 0,
  radiusPx: 12,
  snapToElement: false,
  safeTargets: false,
  ringSize: 'm',
  pauseCorner: 'top-left'
}

function btn(name: string, rect: Rect, role = 'button'): ElementNode {
  return { id: name, role, name, rect, monitorId: 1, enabled: true, patterns: ['invoke'] }
}

interface Fake {
  c: DwellController
  input: InputStep[][]
  rings: DwellRingData[]
  overlays: DwellOverlay[]
  said: string[]
  states: DwellPaletteState[]
  holds: boolean[]
  set: (s: Partial<DwellSettings>) => void
  tick: (ms: number) => void
}

/** Logical = physical / scale; one 1920x1080 display; palette at x >= 1800. */
function fake(
  over: Partial<DwellSettings> = {},
  opts: { scale?: number; nodes?: ElementNode[] } = {}
): Fake {
  const scale = opts.scale ?? 1
  let settings = { ...BASE, ...over }
  let t = 1000
  const f = {
    input: [] as InputStep[][],
    rings: [] as DwellRingData[],
    overlays: [] as DwellOverlay[],
    said: [] as string[],
    states: [] as DwellPaletteState[],
    holds: [] as boolean[]
  }
  const io: DwellIo = {
    now: () => t,
    settings: () => settings,
    input: async (steps) => {
      f.input.push(steps)
    },
    physToLogical: (p: Point) => ({ x: p.x / scale, y: p.y / scale }),
    logicalToPhys: (p: Point) => ({ x: p.x * scale, y: p.y * scale }),
    physRectToLogical: (r: Rect) => ({
      x: r.x / scale,
      y: r.y / scale,
      w: r.w / scale,
      h: r.h / scale
    }),
    displayAt: () => ({ bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scale }),
    overPalette: (p) => p.x >= 1800,
    nodes: () => opts.nodes ?? [],
    holdAgent: (on) => f.holds.push(on),
    ring: (r) => f.rings.push(r),
    overlay: (o) => f.overlays.push(o),
    paletteState: (s) => f.states.push(s),
    announce: (s) => f.said.push(s),
    log: () => {}
  }
  return {
    ...f,
    c: new DwellController(io),
    set: (s) => (settings = { ...settings, ...s }),
    tick: (ms) => (t += ms)
  }
}

const at = (x: number, y: number): { x: number; y: number } => ({ x, y })

describe('dwell config', () => {
  it('maps settings onto the agent: always left, radius in physical px, snap for safety', () => {
    const s = dwellSettings(makeConfig({ dwellClick: { enabled: true, dwellMs: 900 } }))
    expect(s.ms).toBe(900)
    const a = agentDwellConfig({ ...s, radiusPx: 12, clickType: 'right' }, 1.5)
    expect(a).toMatchObject({ enabled: true, ms: 900, clickType: 'left', moveTolerancePx: 18 })
    expect(a.maxRepeats).toBe(0)
    expect(a.snapToElement).toBe(true) // safeTargets defaults on
    expect(
      agentDwellConfig({ ...s, safeTargets: false, snapToElement: false }, 1).snapToElement
    ).toBe(false)
  })
})

describe('dwell helpers', () => {
  it('risky names', () => {
    for (const n of ['Delete', 'Send', 'Buy now', 'Place order', "Don't save", 'Remove item'])
      expect(isRiskyName(n), n).toBe(true)
    for (const n of ['Sender info', 'Paste', 'Open', 'Save', undefined])
      expect(isRiskyName(n), String(n)).toBe(false)
  })

  it('corner zones', () => {
    const d = { x: 0, y: 0, w: 1920, h: 1080 }
    expect(inCorner(at(5, 5), d, 'top-left')).toBe(true)
    expect(inCorner(at(60, 5), d, 'top-left')).toBe(false)
    expect(inCorner(at(1915, 1075), d, 'bottom-right')).toBe(true)
    expect(inCorner(at(5, 5), d, 'none')).toBe(false)
  })

  it('snaps to the nearest invokable control within reach, smallest when nested', () => {
    const box = btn('Agree', { x: 100, y: 100, w: 12, h: 12 }, 'checkbox')
    const big = btn('Panel', { x: 0, y: 0, w: 500, h: 500 }, 'listitem')
    const far = btn('Far', { x: 300, y: 300, w: 20, h: 20 })
    expect(snapTarget(at(120, 106), [big, box, far], 24)?.name).toBe('Agree')
    expect(snapTarget(at(140, 106), [box, far], 24)).toBeNull()
    expect(snapTarget(at(105, 105), [big, box], 24)?.name).toBe('Agree')
    const off = { ...box, enabled: false }
    expect(snapTarget(at(105, 105), [off], 24)).toBeNull()
  })

  it('scroll arrow hit test', () => {
    const c = at(500, 500)
    expect(scrollArrowAt(c, at(500, 500 - SCROLL_REACH_PX))).toBe('up')
    expect(scrollArrowAt(c, at(500 + SCROLL_REACH_PX + 10, 505))).toBe('right')
    expect(scrollArrowAt(c, at(500, 500))).toBeNull()
  })
})

describe('DwellController', () => {
  it('a dwell clicks once where it finished (left by default)', async () => {
    const f = fake()
    await f.c.onTrigger({ x: 400, y: 300 })
    expect(f.input).toEqual([[{ t: 'click', button: 'left', count: 1, x: 400, y: 300 }]])
  })

  it('a palette pick applies to the next dwell only, then back to the default', async () => {
    const f = fake()
    f.c.choose('right')
    expect(f.states.at(-1)?.next).toBe('right')
    await f.c.onTrigger({ x: 10 + 400, y: 300 })
    await f.c.onTrigger({ x: 600, y: 300 })
    expect(f.input.map((s) => (s[0] as { button: string }).button)).toEqual(['right', 'left'])
    expect(f.states.at(-1)?.next).toBe('left')
  })

  it('sticky keeps the pick', async () => {
    const f = fake({ sticky: true })
    f.c.choose('double')
    await f.c.onTrigger({ x: 400, y: 300 })
    await f.c.onTrigger({ x: 600, y: 300 })
    expect(f.input.map((s) => (s[0] as { count: number }).count)).toEqual([2, 2])
  })

  it('drag takes two dwells: start, then drop', async () => {
    const f = fake()
    f.c.choose('drag')
    await f.c.onTrigger({ x: 100, y: 100 })
    expect(f.input).toEqual([])
    expect(f.overlays.at(-1)).toEqual({ dragFrom: { x: 100, y: 100 } })
    expect(f.c.state().dragging).toBe(true)
    await f.c.onTrigger({ x: 700, y: 500 })
    expect(f.input).toEqual([[{ t: 'drag', from: { x: 100, y: 100 }, to: { x: 700, y: 500 } }]])
    expect(f.overlays.at(-1)).toEqual({})
    expect(f.c.state()).toMatchObject({ dragging: false, next: 'left' })
  })

  it('scroll mode: arrows at the dwell point, dwelling on one scrolls there, elsewhere closes', async () => {
    const f = fake()
    f.c.choose('scroll')
    await f.c.onTrigger({ x: 500, y: 500 })
    expect(f.overlays.at(-1)).toEqual({ scrollAt: { x: 500, y: 500 } })
    await f.c.onTrigger({ x: 500, y: 500 + SCROLL_REACH_PX })
    await f.c.onTrigger({ x: 500, y: 500 - SCROLL_REACH_PX })
    expect(f.input).toEqual([
      [{ t: 'scroll', dx: 0, dy: 5, x: 500, y: 500 }],
      [{ t: 'scroll', dx: 0, dy: -5, x: 500, y: 500 }]
    ])
    await f.c.onTrigger({ x: 900, y: 900 })
    expect(f.input).toHaveLength(2)
    expect(f.overlays.at(-1)).toEqual({})
    expect(f.c.state()).toMatchObject({ scrolling: false, next: 'left' })
  })

  it('the pause corner toggles pause; paused dwells click nothing', async () => {
    const f = fake()
    await f.c.onTrigger({ x: 3, y: 3 })
    expect(f.c.paused).toBe(true)
    expect(f.said.at(-1)).toBe('Dwell paused')
    await f.c.onTrigger({ x: 400, y: 300 })
    expect(f.input).toEqual([])
    await f.c.onTrigger({ x: 3, y: 3 })
    expect(f.c.paused).toBe(false)
    await f.c.onTrigger({ x: 400, y: 300 })
    expect(f.input).toHaveLength(1)
  })

  it('the palette stays clickable (left) while paused and whatever the pick', async () => {
    const f = fake()
    f.c.choose('right')
    f.c.setPaused(true)
    await f.c.onTrigger({ x: 1850, y: 200 })
    expect(f.input).toEqual([[{ t: 'click', button: 'left', count: 1, x: 1850, y: 200 }]])
    expect(f.c.next()).toBe('right')
  })

  it('no click while automation holds dwell; holds are counted', async () => {
    const f = fake()
    const r1 = f.c.hold('automation')
    const r2 = f.c.hold('automation')
    expect(f.holds).toEqual([true])
    await f.c.onTrigger({ x: 400, y: 300 })
    expect(f.input).toEqual([])
    r1()
    r1()
    expect(f.holds).toEqual([true])
    r2()
    expect(f.holds).toEqual([true, false])
    await f.c.onTrigger({ x: 400, y: 300 })
    expect(f.input).toHaveLength(1)
  })

  it('holdDwell is a no-op without a controller', () => {
    setDwellController(null)
    expect(() => holdDwell('x')()).not.toThrow()
    const f = fake()
    setDwellController(f.c)
    holdDwell('automation')()
    expect(f.holds).toEqual([true, false])
    setDwellController(null)
  })

  it('snap clicks the centre of a tiny control near the cursor (150%)', async () => {
    const box = btn('Remember me', { x: 300, y: 300, w: 18, h: 18 }, 'checkbox')
    const f = fake({ snapToElement: true }, { scale: 1.5, nodes: [box] })
    // 25 physical px right of the box: inside 24 logical (36 physical) reach.
    await f.c.onTrigger({ x: 343, y: 305 })
    expect(f.input).toEqual([[{ t: 'click', button: 'left', count: 1, x: 309, y: 309 }]])
  })

  it('the ring shows the snapped target and the click type', () => {
    const box = btn('Ok', { x: 300, y: 300, w: 20, h: 20 })
    const f = fake({ snapToElement: true, ringSize: 'l' }, { nodes: [box] })
    f.c.choose('double')
    f.c.onProgress({ x: 310, y: 330, progress: 0.4, active: true })
    expect(f.rings.at(-1)).toMatchObject({
      x: 310,
      y: 330,
      progress: 0.4,
      active: true,
      size: 64,
      clickType: 'double',
      target: { x: 300, y: 300, w: 20, h: 20 }
    })
  })

  it('a paused ring only shows over the corner or the palette', () => {
    const f = fake()
    f.c.setPaused(true)
    f.c.onProgress({ x: 400, y: 300, progress: 0.5, active: true })
    expect(f.rings.at(-1)).toMatchObject({ active: false, paused: true })
    f.c.onProgress({ x: 4, y: 4, progress: 0.5, active: true })
    expect(f.rings.at(-1)).toMatchObject({ active: true, paused: true, clickType: 'pause' })
  })

  it('risky targets need a second dwell within the window', async () => {
    const f = fake({ safeTargets: true })
    const del = {
      x: 400,
      y: 300,
      element: { name: 'Delete', role: 'button', rect: { x: 390, y: 290, w: 40, h: 20 } }
    }
    await f.c.onTrigger(del)
    expect(f.input).toEqual([])
    expect(f.said.at(-1)).toMatch(/Delete: dwell on it again/)
    await f.c.onTrigger({ ...del, x: 402 })
    expect(f.input).toHaveLength(1)
    // A later first dwell asks again; an expired confirm does not count.
    await f.c.onTrigger(del)
    f.tick(CONFIRM_MS + 1)
    await f.c.onTrigger(del)
    expect(f.input).toHaveLength(1)
  })

  it('safe names click at once even with safeTargets on', async () => {
    const f = fake({ safeTargets: true })
    await f.c.onTrigger({ x: 400, y: 300, element: { name: 'Open', role: 'button' } })
    expect(f.input).toHaveLength(1)
  })

  it('reset drops a half-done drag and the pick', async () => {
    const f = fake()
    f.c.choose('drag')
    await f.c.onTrigger({ x: 100, y: 100 })
    f.c.reset()
    expect(f.c.state()).toMatchObject({ dragging: false, next: 'left' })
    expect(f.overlays.at(-1)).toEqual({})
  })

  it('does nothing when dwell is off, and ignores malformed events', async () => {
    const f = fake({ enabled: false })
    await f.c.onTrigger({ x: 1, y: 2 })
    f.c.onProgress({ x: 1, y: 2, progress: 1, active: true })
    expect(f.input).toEqual([])
    expect(f.rings).toEqual([])
    expect(f.c.setPaused(true)).toBe(false)
    const g = fake()
    await g.c.onTrigger({ x: 'a' })
    await g.c.onTrigger(null)
    expect(g.input).toEqual([])
  })

  it('palette pause button toggles pause', () => {
    const f = fake()
    f.c.choose('pause')
    expect(f.c.state().paused).toBe(true)
    f.c.choose('pause')
    expect(f.c.state().paused).toBe(false)
  })
})
