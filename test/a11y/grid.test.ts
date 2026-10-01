import { describe, expect, it } from 'vitest'
import { MIN_CELL_PX, MouseGrid, cellRect, center } from '../../src/main/a11y/grid'
import type { Point, Rect } from '../../src/shared/types'

const SCREEN = { x: 0, y: 0, w: 1920, h: 1080 }

const inside = (p: Point, r: Rect): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/** The cell (1-9) of `rect` that holds `p`. */
function cellFor(rect: Rect, p: Point): number {
  const col = Math.min(2, Math.floor(((p.x - rect.x) / rect.w) * 3))
  const row = Math.min(2, Math.floor(((p.y - rect.y) / rect.h) * 3))
  return row * 3 + col + 1
}

describe('cellRect', () => {
  it('numbers cells left to right, top to bottom', () => {
    expect(cellRect(SCREEN, 1)).toEqual({ x: 0, y: 0, w: 640, h: 360 })
    expect(cellRect(SCREEN, 3)).toEqual({ x: 1280, y: 0, w: 640, h: 360 })
    expect(cellRect(SCREEN, 5)).toEqual({ x: 640, y: 360, w: 640, h: 360 })
    expect(cellRect(SCREEN, 9)).toEqual({ x: 1280, y: 720, w: 640, h: 360 })
  })

  it('works on a monitor with a negative origin', () => {
    expect(cellRect({ x: -1920, y: 0, w: 1920, h: 1080 }, 1)).toEqual({
      x: -1920,
      y: 0,
      w: 640,
      h: 360
    })
  })
})

describe('MouseGrid', () => {
  it('shows the whole monitor at level 0', () => {
    const g = new MouseGrid()
    expect(g.shown).toBe(false)
    expect(g.scene()).toBeUndefined()
    g.show(SCREEN, 7)
    expect(g.scene()).toEqual({ rect: SCREEN, cols: 3, rows: 3, level: 0 })
    expect(g.monitorId).toBe(7)
    expect(g.target()).toEqual({ x: 960, y: 540 })
  })

  it('zooms into a cell and back up', () => {
    const g = new MouseGrid()
    g.show(SCREEN, 1)
    expect(g.select(9)).toBe(true)
    expect(g.rect).toEqual({ x: 1280, y: 720, w: 640, h: 360 })
    expect(g.level).toBe(1)
    expect(g.up()).toBe(true)
    expect(g.rect).toEqual(SCREEN)
    expect(g.up()).toBe(false)
  })

  it('rejects numbers outside 1-9', () => {
    const g = new MouseGrid()
    g.show(SCREEN, 1)
    expect(g.select(0)).toBe(false)
    expect(g.select(10)).toBe(false)
    expect(g.level).toBe(0)
  })

  it('reaches any point within a few pixels in 4 to 5 numbers', () => {
    const targets: Point[] = [
      { x: 3, y: 3 },
      { x: 1917, y: 1077 },
      { x: 961, y: 541 },
      { x: 250, y: 900 }
    ]
    for (const p of targets) {
      const g = new MouseGrid()
      g.show(SCREEN, 1)
      for (let i = 0; i < 4; i++) g.select(cellFor(g.rect!, p))
      // 1920 / 3^4 ≈ 24 px wide, 1080 / 3^4 ≈ 13 px tall: the centre is within 12 px.
      expect(inside(p, g.rect!)).toBe(true)
      const c = g.target()!
      expect(Math.abs(c.x - p.x)).toBeLessThanOrEqual(12)
      expect(Math.abs(c.y - p.y)).toBeLessThanOrEqual(7)
      g.select(cellFor(g.rect!, p))
      expect(g.atMinimum).toBe(true)
    }
  })

  it('stops zooming once a cell is the minimum size', () => {
    const g = new MouseGrid()
    g.show({ x: 0, y: 0, w: 60, h: 60 }, 1)
    expect(g.select(5)).toBe(true)
    expect(g.rect!.w).toBeLessThanOrEqual(MIN_CELL_PX)
    expect(g.select(5)).toBe(false)
  })

  it('drags: mark sets the start and resets to the monitor, drop finishes and closes', () => {
    const g = new MouseGrid()
    g.show(SCREEN, 1)
    g.select(1)
    const from = g.markDrag()
    expect(from).toEqual(center(cellRect(SCREEN, 1)))
    expect(g.level).toBe(0)
    g.select(9)
    const d = g.drop()
    expect(d).toEqual({ from, to: center(cellRect(SCREEN, 9)) })
    expect(g.shown).toBe(false)
    expect(g.dragFrom).toBeNull()
  })

  it('drop without a start does nothing', () => {
    const g = new MouseGrid()
    g.show(SCREEN, 1)
    expect(g.drop()).toBeNull()
    expect(g.shown).toBe(true)
  })

  it('close forgets everything', () => {
    const g = new MouseGrid()
    g.show(SCREEN, 1)
    g.select(2)
    g.markDrag()
    g.close()
    expect(g.shown).toBe(false)
    expect(g.monitorId).toBeNull()
    expect(g.target()).toBeNull()
  })
})
