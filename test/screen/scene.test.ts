import { describe, expect, it } from 'vitest'
import { nextExpiry, reconcile, showHighlightLabel } from '../../src/renderer/src/screen/scene'
import { pillSize, placeLabels } from '../../src/renderer/src/screen/labels'
import { layoutMarks } from '../../src/renderer/src/screen/marks'
import { overlaps } from '../../src/renderer/src/screen/geometry'
import { addSample, displayed, initialInterp } from '../../src/renderer/src/screen/dwell-interp'

type H = { id: string; v: number }
const key = (h: H): string => h.id

describe('reconcile', () => {
  it('keeps removed items as exiting until the exit time passes', () => {
    let list = reconcile<H>(
      [],
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 1 }
      ],
      key,
      0,
      100
    )
    list = reconcile(list, [{ id: 'b', v: 2 }], key, 10, 100)
    expect(list.map((p) => [p.key, p.exiting, p.item.v])).toEqual([
      ['b', false, 2],
      ['a', true, 1]
    ])
    expect(nextExpiry(list, 10, 100)).toBe(100)
    list = reconcile(list, [{ id: 'b', v: 2 }], key, 60, 100)
    expect(list[1].since).toBe(10)
    list = reconcile(list, [{ id: 'b', v: 2 }], key, 111, 100)
    expect(list.map((p) => p.key)).toEqual(['b'])
    expect(nextExpiry(list, 111, 100)).toBeNull()
  })

  it('brings an exiting item back to life', () => {
    let list = reconcile<H>([], [{ id: 'a', v: 1 }], key, 0, 100)
    list = reconcile(list, [], key, 10, 100)
    list = reconcile(list, [{ id: 'a', v: 3 }], key, 20, 100)
    expect(list).toEqual([{ key: 'a', item: { id: 'a', v: 3 }, exiting: false, since: 0 }])
  })

  it('a guide step change with the same id updates in place (the ring morphs)', () => {
    let list = reconcile<H>([], [{ id: 'h0', v: 1 }], key, 0, 100)
    list = reconcile(list, [{ id: 'h0', v: 2 }], key, 5, 100)
    expect(list).toHaveLength(1)
    expect(list[0].item.v).toBe(2)
  })
})

describe('labels', () => {
  it('hides a highlight label the buddy already shows', () => {
    expect(showHighlightLabel('Click Compose', '1/3: Click Compose')).toBe(false)
    expect(showHighlightLabel('Click Compose', undefined)).toBe(true)
    expect(showHighlightLabel(undefined, 'x')).toBe(false)
  })

  it('caps pills at 22rem and two lines', () => {
    expect(pillSize('Hi', 16).h).toBeLessThan(pillSize('x'.repeat(200), 16).h)
    expect(pillSize('x'.repeat(500), 16).w).toBe(352)
  })

  it('places labels clear of targets and each other', () => {
    const view = { w: 1920, h: 1080 }
    const a = { x: 100, y: 100, w: 200, h: 40 }
    const b = { x: 100, y: 160, w: 200, h: 40 }
    const size = { w: 150, h: 30 }
    const placed = placeLabels(
      [
        { id: 'a', anchor: a, size },
        { id: 'b', anchor: b, size }
      ],
      [a, b],
      view
    )
    const la = placed.get('a')!
    const lb = placed.get('b')!
    for (const r of [a, b, lb]) expect(overlaps(la, r)).toBe(false)
    for (const r of [a, b]) expect(overlaps(lb, r)).toBe(false)
  })

  it('keeps labels on screen at the bottom edge', () => {
    const view = { w: 800, h: 600 }
    const a = { x: 700, y: 570, w: 100, h: 30 }
    const l = placeLabels([{ id: 'a', anchor: a, size: { w: 200, h: 30 } }], [a], view).get('a')!
    expect(l.x + l.w).toBeLessThanOrEqual(800)
    expect(l.y + l.h).toBeLessThanOrEqual(600)
    expect(overlaps(l, a)).toBe(false)
  })
})

describe('layoutMarks', () => {
  const view = { w: 1920, h: 1080 }

  it('moves a badge that would overlap an earlier one', () => {
    const marks = [
      { n: 1, rect: { x: 100, y: 100, w: 200, h: 30 } },
      { n: 2, rect: { x: 104, y: 102, w: 200, h: 30 } }
    ]
    const [m1, m2] = layoutMarks(marks, 16, view)
    expect(overlaps(m1.box, m2.box)).toBe(false)
  })

  it('lays out 300 marks quickly', () => {
    const marks = Array.from({ length: 300 }, (_, i) => ({
      n: i + 1,
      rect: { x: (i % 20) * 90 + 30, y: Math.floor(i / 20) * 60 + 30, w: 80, h: 24 }
    }))
    const t0 = performance.now()
    const out = layoutMarks(marks, 16, view)
    expect(performance.now() - t0).toBeLessThan(16)
    expect(out).toHaveLength(300)
  })
})

describe('dwell arc interpolation', () => {
  it('moves on between samples without overshooting', () => {
    let s = initialInterp()
    s = addSample(s, 0.1, 0, 0)
    s = addSample(s, 0.14, 40, 0.1)
    expect(displayed(s, 40)).toBeCloseTo(0.14)
    expect(displayed(s, 60)).toBeCloseTo(0.16)
    expect(displayed(s, 2000)).toBeLessThanOrEqual(0.14 + 0.08 + 1e-9)
  })

  it('retracts over 120ms when progress drops', () => {
    let s = addSample(initialInterp(), 0.8, 0, 0)
    s = addSample(s, 0, 50, 0.8)
    expect(displayed(s, 50)).toBeCloseTo(0.8)
    expect(displayed(s, 110)).toBeCloseTo(0.4)
    expect(displayed(s, 200)).toBe(0)
  })
})
