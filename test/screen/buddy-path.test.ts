import { describe, expect, it } from 'vitest'
import {
  angleDelta,
  bezierAt,
  chooseAnchor,
  controlPoint,
  entryPoint,
  flightDuration,
  flightFrame,
  followPoint,
  nudge,
  planFlight,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS
} from '../../src/renderer/src/screen/buddyPath'
import { containsPoint, inside, overlaps } from '../../src/renderer/src/screen/geometry'

const VIEW = { w: 1920, h: 1080 }

describe('chooseAnchor', () => {
  it('parks just outside the bottom-left corner first', () => {
    const t = { x: 400, y: 300, w: 120, h: 40 }
    const a = chooseAnchor(t, VIEW)
    expect(a.corner).toBe('bottom-left')
    expect(a.tip).toEqual({ x: 394, y: 346 })
    expect(containsPoint(t, a.tip)).toBe(false)
  })

  it('falls back to the other corners near the screen edges', () => {
    expect(chooseAnchor({ x: 0, y: 300, w: 100, h: 40 }, VIEW).corner).toBe('bottom-right')
    expect(chooseAnchor({ x: 400, y: 1050, w: 100, h: 30 }, VIEW).corner).toBe('top-left')
    expect(chooseAnchor({ x: 0, y: 1050, w: 100, h: 30 }, VIEW).corner).toBe('top-right')
  })

  it('does not cover a neighbouring highlight', () => {
    const t = { x: 400, y: 300, w: 120, h: 40 }
    const neighbour = { x: 360, y: 345, w: 40, h: 40 }
    const a = chooseAnchor(t, VIEW, [neighbour])
    expect(a.corner).toBe('bottom-right')
    expect(overlaps(a.body, neighbour)).toBe(false)
  })

  it('never sits inside the target or offscreen, whatever the target', () => {
    const targets = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 1910, y: 1070, w: 10, h: 10 },
      { x: 960, y: 540, w: 1, h: 1 },
      { x: -50, y: 500, w: 100, h: 50 },
      { x: 5, y: 5, w: 1910, h: 1070 },
      { x: 0, y: 0, w: 1920, h: 1080 }
    ]
    for (const size of ['s', 'm', 'l', 'xl'] as const) {
      for (const t of targets) {
        const a = chooseAnchor(t, VIEW, [], size)
        expect(inside(a.body, VIEW), JSON.stringify({ t, size })).toBe(true)
        // A target that leaves no room for the body on any side is the one exception.
        const room = Math.max(t.x, t.y, VIEW.w - t.x - t.w, VIEW.h - t.y - t.h) >= 50
        if (room) expect(containsPoint(t, a.tip), JSON.stringify(t)).toBe(false)
      }
    }
  })
})

describe('followPoint', () => {
  it('sits at cursor +18,+18 and flips near the edges', () => {
    expect(followPoint({ x: 100, y: 100 }, VIEW).tip).toEqual({ x: 118, y: 118 })
    expect(followPoint({ x: 1900, y: 100 }, VIEW).tip).toEqual({ x: 1882, y: 118 })
    expect(followPoint({ x: 100, y: 1070 }, VIEW).tip).toEqual({ x: 118, y: 1052 })
  })
})

describe('flight', () => {
  it('clamps the duration', () => {
    expect(flightDuration(0)).toBe(FLIGHT_MIN_MS)
    expect(flightDuration(5000)).toBe(FLIGHT_MAX_MS)
    expect(flightDuration(600)).toBeCloseTo(390)
  })

  it('arcs toward the upper side, at most 120px off the line', () => {
    const c = controlPoint({ x: 0, y: 500 }, { x: 400, y: 500 })
    expect(c).toEqual({ x: 200, y: 420 })
    const far = controlPoint({ x: 0, y: 500 }, { x: 1800, y: 500 })
    expect(far.y).toBe(380)
    const back = controlPoint({ x: 400, y: 500 }, { x: 0, y: 500 })
    expect(back.y).toBeLessThan(500)
  })

  it('starts and ends on the endpoints and settles to the arrival angle', () => {
    const f = planFlight({ x: 0, y: 0 }, { x: 400, y: 300 }, -135, -45)
    expect(flightFrame(f, 0).pos).toEqual({ x: 0, y: 0 })
    const end = flightFrame(f, f.durationMs + 50)
    expect(end).toEqual({ pos: { x: 400, y: 300 }, angle: -45, scale: 1, done: true })
    const mid = flightFrame(f, f.durationMs / 2)
    expect(mid.scale).toBeCloseTo(1.08)
    expect(mid.done).toBe(false)
  })

  it('leans at most 25 degrees off the rest angle', () => {
    const f = planFlight({ x: 0, y: 500 }, { x: 1500, y: 500 }, -45, -45)
    for (let ms = 0; ms <= f.durationMs; ms += 10) {
      expect(Math.abs(angleDelta(-45, flightFrame(f, ms).angle))).toBeLessThanOrEqual(25.001)
    }
  })

  it('keeps its heading when retargeted mid-flight', () => {
    const heading = { x: 1, y: 0 }
    const c = controlPoint({ x: 100, y: 100 }, { x: 100, y: 500 }, heading)
    expect(c.y).toBe(100)
    expect(c.x).toBeGreaterThan(100)
    const f = planFlight({ x: 100, y: 100 }, { x: 100, y: 500 }, 0, 90, heading)
    const p = bezierAt(f, 0.05)
    expect(p.x).toBeGreaterThan(100)
  })
})

describe('nudge and entry', () => {
  it('nudges toward the target and back to rest', () => {
    expect(nudge(0, 2, 4)).toBe(0)
    expect(nudge(0.25, 2, 4)).toBeCloseTo(4)
    expect(nudge(0.5, 2, 4)).toBeCloseTo(0)
    expect(nudge(1, 2, 4)).toBe(0)
  })

  it('enters from the nearest edge', () => {
    expect(entryPoint({ x: 10, y: 500 }, VIEW)).toEqual({ x: -20, y: 500 })
    expect(entryPoint({ x: 900, y: 1070 }, VIEW)).toEqual({ x: 900, y: 1100 })
  })
})
