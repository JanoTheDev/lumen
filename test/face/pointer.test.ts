import { describe, expect, it, vi } from 'vitest'
import type { FaceFrame } from '@shared/channels'
import { FACE_POINTER_DEFAULTS, type FacePointerConfig } from '@shared/config'
import type { Point } from '@shared/types'
import {
  ABS_MIN_STEP,
  absoluteTarget,
  applyDeadZone,
  AUTO_CENTRE_FRAMES,
  axisSpeed,
  curve,
  deadZoneNorm,
  DEFAULT_RANGE,
  Ema,
  HeadPointer,
  MAX_NORM,
  MoveGate,
  normAxis,
  rangeFromSamples,
  rangeMessage,
  recentred,
  SPEED_UNIT,
  TICK_MS
} from '../../src/main/face/pointer'
import { parsePointerCommand } from '../../src/main/face/voice'

const frame = (yaw: number, pitch: number, face = true): FaceFrame => ({
  face,
  mouthOpen: 0,
  browRaise: 0,
  smile: 0,
  roll: 0,
  yaw,
  pitch
})

describe('head pointer math', () => {
  it('cuts the dead zone out', () => {
    expect(applyDeadZone(2, 3)).toBe(0)
    expect(applyDeadZone(-3, 3)).toBe(0)
    expect(applyDeadZone(5, 3)).toBe(2)
    expect(applyDeadZone(-5, 3)).toBe(-2)
    expect(applyDeadZone(1, 0)).toBe(1)
  })

  it('normalises an angle to the calibrated edges on each side', () => {
    const a = { centre: 2, neg: -18, pos: 22 }
    expect(normAxis(2, a)).toBe(0)
    expect(normAxis(22, a)).toBeCloseTo(1)
    expect(normAxis(-18, a)).toBeCloseTo(-1)
    expect(normAxis(12, a)).toBeCloseTo(0.5)
    expect(normAxis(90, a)).toBe(MAX_NORM)
    // Dead zone: starts at 0 just outside it, still 1 at the edge.
    expect(normAxis(4, a, 3)).toBe(0)
    expect(normAxis(22, a, 3)).toBeCloseTo(1)
    expect(normAxis(6, a, 3)).toBeCloseTo(1 / 17)
  })

  it('follows a range whose head direction is flipped', () => {
    const flipped = { centre: 0, neg: 20, pos: -20 }
    expect(normAxis(-20, flipped)).toBeCloseTo(1)
    expect(normAxis(10, flipped)).toBeCloseTo(-0.5)
    expect(normAxis(5, { centre: 0, neg: 0, pos: 0 })).toBe(0)
  })

  it('curves and scales speed', () => {
    expect(curve(0.5, 1)).toBe(0.5)
    expect(curve(-0.5, 2)).toBe(-0.25)
    expect(curve(0.5, 0.2)).toBe(0.5)
    expect(axisSpeed(1, { speed: 4, acceleration: 1.8 })).toBe(4 * SPEED_UNIT)
    expect(axisSpeed(-0.5, { speed: 1, acceleration: 2 })).toBe(-0.25 * SPEED_UNIT)
    expect(axisSpeed(0, { speed: 10, acceleration: 3 })).toBe(0)
  })

  it('maps absolute offsets onto a display', () => {
    const b = { x: 1920, y: 0, w: 1001, h: 501 }
    expect(absoluteTarget(0, 0, b)).toEqual({ x: 2420, y: 250 })
    expect(absoluteTarget(-1, -1, b)).toEqual({ x: 1920, y: 0 })
    expect(absoluteTarget(5, 5, b)).toEqual({ x: 2920, y: 500 })
  })

  it('recentres keeping the spans', () => {
    const r = recentred(DEFAULT_RANGE, 4, -6)
    expect(r.yaw).toEqual({ centre: 4, neg: -16, pos: 24 })
    expect(r.pitch).toEqual({ centre: -6, neg: -21, pos: 9 })
    expect(deadZoneNorm(r.yaw, 5)).toBeCloseTo(0.25)
  })

  it('smooths with an exponential average', () => {
    const e = new Ema()
    expect(e.step(10, 0.5)).toBe(10)
    expect(e.step(20, 0.5)).toBe(15)
    expect(e.step(20, 0)).toBe(20)
    e.reset()
    expect(e.value).toBeNull()
  })

  it('rate-limits moves and keeps one in flight', () => {
    const g = new MoveGate(30)
    expect(g.minMs).toBe(33)
    expect(g.take(0)).toBe(true)
    expect(g.take(50)).toBe(false) // still in flight
    g.done()
    expect(g.take(20)).toBe(false) // too soon
    expect(g.take(40)).toBe(true)
    g.done()
    expect(TICK_MS).toBeGreaterThanOrEqual(g.minMs)
  })
})

describe('head pointer range calibration', () => {
  const n = (yaw: number, pitch: number, count = 12): { yaw: number; pitch: number }[] =>
    Array.from({ length: count }, (_, i) => ({ yaw: yaw + (i % 3) * 0.2, pitch }))

  it('takes the medians of five looks', () => {
    const r = rangeFromSamples({
      centre: n(0, 0),
      left: n(-15, 0),
      right: n(18, 1),
      up: n(0, -12),
      down: n(0, 10)
    })
    expect(r).toEqual({
      ok: true,
      range: {
        yaw: { centre: 0.2, neg: -14.8, pos: 18.2 },
        pitch: { centre: 0, neg: -12, pos: 10 }
      }
    })
  })

  it('learns a flipped direction and refuses bad samples', () => {
    const flipped = rangeFromSamples({
      centre: n(0, 0),
      left: n(15, 0),
      right: n(-15, 0),
      up: n(0, -10),
      down: n(0, 10)
    })
    expect(flipped.ok && flipped.range.yaw.neg > 0).toBe(true)
    const few = rangeFromSamples({ centre: n(0, 0, 3) })
    expect(few).toEqual({ ok: false, reason: 'few-samples', at: 'centre' })
    const small = rangeFromSamples({
      centre: n(0, 0),
      left: n(-2, 0),
      right: n(15, 0),
      up: n(0, -10),
      down: n(0, 10)
    })
    expect(small).toEqual({ ok: false, reason: 'too-small', at: 'left' })
    if (!small.ok) expect(rangeMessage(small)).toMatch(/to the left/)
    const same = rangeFromSamples({
      centre: n(0, 0),
      left: n(10, 0),
      right: n(15, 0),
      up: n(0, -10),
      down: n(0, 10)
    })
    expect(same).toMatchObject({ ok: false, reason: 'same-side' })
  })
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(cfg: Partial<FacePointerConfig> = {}) {
  const config: FacePointerConfig = { ...FACE_POINTER_DEFAULTS, smoothing: 0, ...cfg }
  let cursor: Point = { x: 500, y: 500 }
  const moves: Point[] = []
  let pending: (() => void) | null = null
  let holdMoves = false
  const move = vi.fn(async (p: Point) => {
    moves.push(p)
    if (holdMoves) await new Promise<void>((r) => (pending = r))
    cursor = p
  })
  const hp = new HeadPointer({
    config: () => config,
    cursor: () => cursor,
    clamp: (p) => ({
      x: Math.min(999, Math.max(0, p.x)),
      y: Math.min(999, Math.max(0, p.y))
    }),
    bounds: () => ({ x: 0, y: 0, w: 1001, h: 1001 }),
    move
  })
  let now = 0
  const feed = (yaw: number, pitch: number, frames = 1): void => {
    for (let i = 0; i < frames; i++) hp.onFrame(frame(yaw, pitch))
  }
  /** Ticks for `ms`; each move settles before the next tick. */
  const run = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += TICK_MS) {
      now += TICK_MS
      hp.tick(now)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return {
    hp,
    config,
    moves,
    move,
    feed,
    run,
    setCursor: (p: Point) => (cursor = p),
    cursor: () => cursor,
    hold: (on: boolean) => (holdMoves = on),
    release: () => pending?.()
  }
}

describe('head pointer', () => {
  it('centres itself on the first frames when nothing is calibrated', async () => {
    const s = setup()
    s.feed(5, -4, AUTO_CENTRE_FRAMES - 1)
    await s.run(200)
    expect(s.moves).toEqual([])
    s.feed(5, -4)
    expect(s.hp.view()).toMatchObject({ nx: 0, ny: 0 })
    await s.run(200)
    expect(s.moves).toEqual([]) // at the centre: still
  })

  it('moves like a joystick toward where the head turns', async () => {
    const s = setup({ speed: 4, acceleration: 1, deadZone: 0 })
    s.feed(0, 0, AUTO_CENTRE_FRAMES)
    s.feed(20, 0) // right edge
    await s.run(TICK_MS) // first tick only starts the clock
    await s.run(TICK_MS * 30)
    // ~800 px/s (about 27 px a tick) until the display edge stops it.
    expect(s.moves.length).toBeGreaterThan(15)
    expect(s.moves[1].x - s.moves[0].x).toBeGreaterThan(20)
    const last = s.moves[s.moves.length - 1]
    expect(last.x).toBe(999)
    expect(last.y).toBe(500)
    s.feed(0, -15) // up edge
    const before = s.cursor().y
    await s.run(TICK_MS * 5)
    expect(s.cursor().y).toBeLessThan(before)
  })

  it('holds still inside the dead zone, paused or without a face', async () => {
    const s = setup({ deadZone: 3 })
    s.feed(0, 0, AUTO_CENTRE_FRAMES)
    s.feed(2.5, -2)
    await s.run(500)
    expect(s.moves).toEqual([])
    s.hp.setPaused(true)
    s.feed(20, 0)
    await s.run(300)
    expect(s.moves).toEqual([])
    s.hp.setPaused(false)
    s.hp.onFrame(frame(0, 0, false))
    await s.run(300)
    expect(s.moves).toEqual([])
    expect(s.hp.view().paused).toBe(false)
  })

  it('never sends more than one move at a time or above 30 Hz', async () => {
    const s = setup({ deadZone: 0 })
    s.feed(0, 0, AUTO_CENTRE_FRAMES)
    s.feed(20, 0)
    s.hold(true)
    await s.run(TICK_MS * 10)
    expect(s.moves.length).toBe(1)
    s.release()
    s.hold(false)
    await Promise.resolve()
    await Promise.resolve()
    const t0 = s.moves.length
    await s.run(1000)
    expect(s.moves.length - t0).toBeLessThanOrEqual(30)
  })

  it('follows the real pointer when the user moves the mouse', async () => {
    const s = setup({ acceleration: 1, deadZone: 0, speed: 1 })
    s.feed(0, 0, AUTO_CENTRE_FRAMES)
    s.feed(20, 0)
    await s.run(TICK_MS * 3)
    s.setCursor({ x: 100, y: 100 })
    await s.run(TICK_MS)
    const last = s.moves[s.moves.length - 1]
    expect(last.x).toBeGreaterThanOrEqual(100)
    expect(last.x).toBeLessThan(110)
    expect(last.y).toBe(100)
  })

  it('recentres on the current pose', async () => {
    const s = setup({ deadZone: 0 })
    s.feed(0, 0, AUTO_CENTRE_FRAMES)
    s.feed(10, 5)
    expect(s.hp.view().nx).toBeGreaterThan(0)
    expect(s.hp.recentre()).toBe(true)
    expect(s.hp.view()).toMatchObject({ nx: 0, ny: 0 })
    s.hp.onFrame(frame(0, 0, false))
    expect(s.hp.recentre()).toBe(false)
  })

  it('points at the screen in absolute mode, ignoring jitter', async () => {
    const s = setup({
      mode: 'absolute',
      range: { yaw: { centre: 0, neg: -20, pos: 20 }, pitch: { centre: 0, neg: -10, pos: 10 } }
    })
    s.feed(10, -5)
    await s.run(TICK_MS)
    expect(s.moves).toEqual([{ x: 750, y: 250 }])
    s.feed(10.05, -5) // well under ABS_MIN_STEP px
    await s.run(TICK_MS * 3)
    expect(s.moves.length).toBe(1)
    expect(ABS_MIN_STEP).toBeGreaterThan(1)
    s.feed(-20, 10)
    await s.run(TICK_MS)
    expect(s.moves[s.moves.length - 1]).toEqual({ x: 0, y: 1000 })
  })
})

describe('head pointer voice', () => {
  it('parses whole commands only', () => {
    expect(parsePointerCommand('Recentre.')).toBe('recentre')
    expect(parsePointerCommand('recenter the pointer')).toBe('recentre')
    expect(parsePointerCommand('re-center head pointer')).toBe('recentre')
    expect(parsePointerCommand('pause the head pointer')).toBe('pause')
    expect(parsePointerCommand('resume head pointer please')).toBe('resume')
    expect(parsePointerCommand('turn on the head pointer')).toBe('on')
    expect(parsePointerCommand('head mouse off')).toBe('off')
    expect(parsePointerCommand('stop the face pointer')).toBe('off')
    expect(parsePointerCommand('recentre the image in my document')).toBeNull()
    expect(parsePointerCommand('pause the music')).toBeNull()
    expect(parsePointerCommand('')).toBeNull()
  })
})
