// Property-style coordinate tables over the shared display fixtures (100/125/150/200% and the
// dual / negative-origin layouts): image -> physical -> logical and back.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import {
  frameGeometryOf,
  imageRectToPhys,
  imageToPhys,
  logicalToPhys,
  physRectToImage,
  physRectToLogical,
  physToImage,
  physToLogical,
  primaryFrameGeometry,
  setScreenAdapter,
  type FrameGeometry
} from '../src/main/actions/coords'
import {
  ALL_LAYOUTS,
  DUAL_150_100,
  DUAL_NEGATIVE,
  RETINA_150,
  screenAdapterFor,
  type TestDisplay
} from './helpers/displays'

afterEach(() => setScreenAdapter(null))

/** The frame a capture of `d` reports: its physical rect, downscaled to 1280 wide. */
function frameOf(d: TestDisplay, maxWidth = 1280): FrameGeometry {
  const p = d.physBounds
  const imgW = Math.min(p.width, maxWidth)
  const imgH = Math.round((p.height * imgW) / p.width)
  return frameGeometryOf({
    width: imgW,
    height: imgH,
    monitor: {
      id: d.id,
      rect: { x: p.x, y: p.y, w: p.width, h: p.height },
      scale: d.scaleFactor,
      primary: d.primary
    }
  })
}

/** A spread of image points: corners (inset 1px), centre, and an odd interior grid. */
function samplePoints(f: FrameGeometry): { x: number; y: number }[] {
  const pts = [
    { x: 0, y: 0 },
    { x: f.imgW - 1, y: 0 },
    { x: 0, y: f.imgH - 1 },
    { x: f.imgW - 1, y: f.imgH - 1 },
    { x: f.imgW / 2, y: f.imgH / 2 }
  ]
  for (let i = 1; i < 6; i++) pts.push({ x: (f.imgW * i) / 7 + 0.3, y: (f.imgH * i) / 9 + 0.7 })
  return pts
}

const cases = ALL_LAYOUTS.flatMap((layout) =>
  layout.displays.map((d) => [`${layout.name} / ${d.label}`, layout, d] as const)
)

describe.each(cases)('%s', (_name, layout, d) => {
  it('image -> phys stays on this monitor and phys -> logical -> phys round-trips within 1px', () => {
    setScreenAdapter(screenAdapterFor(layout))
    const f = frameOf(d)
    const pb = d.physBounds
    for (const pt of samplePoints(f)) {
      const phys = imageToPhys(f, pt)
      expect(phys.x).toBeGreaterThanOrEqual(pb.x)
      expect(phys.x).toBeLessThanOrEqual(pb.x + pb.width)
      expect(phys.y).toBeGreaterThanOrEqual(pb.y)
      expect(phys.y).toBeLessThanOrEqual(pb.y + pb.height)

      const logical = physToLogical(phys)
      const b = d.bounds
      expect(logical.x).toBeGreaterThanOrEqual(b.x - 1)
      expect(logical.x).toBeLessThanOrEqual(b.x + b.width + 1)

      const back = logicalToPhys(logical)
      expect(Math.abs(back.x - phys.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.y - phys.y)).toBeLessThanOrEqual(1)

      // And back to the image the model saw, within one image pixel.
      const img = physToImage(f, phys)
      expect(Math.abs(img.x - pt.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(img.y - pt.y)).toBeLessThanOrEqual(1)
    }
  })

  it('an image rect maps to the logical rect of the same screen area', () => {
    setScreenAdapter(screenAdapterFor(layout))
    const f = frameOf(d)
    const img = { x: 100, y: 60, w: 200, h: 40 }
    const phys = imageRectToPhys(f, img)
    const logical = physRectToLogical(phys)
    const toPhys = d.physBounds.width / f.imgW
    const expected = {
      x: d.bounds.x + (img.x * toPhys) / d.scaleFactor,
      y: d.bounds.y + (img.y * toPhys) / d.scaleFactor,
      w: (img.w * toPhys) / d.scaleFactor,
      h: (img.h * toPhys) / d.scaleFactor
    }
    expect(Math.abs(logical.x - expected.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(logical.y - expected.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(logical.w - expected.w)).toBeLessThanOrEqual(1)
    expect(Math.abs(logical.h - expected.h)).toBeLessThanOrEqual(1)
    expect(physRectToImage(f, phys)).toEqual(img)
  })
})

describe('1280-wide frame of a 2880-wide monitor at 150%', () => {
  it('maps an image rect to the correct logical rect', () => {
    setScreenAdapter(screenAdapterFor(RETINA_150))
    const d = RETINA_150.displays[0]
    const f = frameOf(d)
    expect(f).toMatchObject({ width: 2880, height: 1800, imgW: 1280, imgH: 800 })
    // 2880 / 1280 = 2.25 physical px per image px, / 1.5 = 1.5 logical px per image px.
    const logical = physRectToLogical(imageRectToPhys(f, { x: 640, y: 400, w: 64, h: 32 }))
    expect(logical).toEqual({ x: 960, y: 600, w: 96, h: 48 })
  })

  it('primaryFrameGeometry agrees with the capture-reported geometry', () => {
    setScreenAdapter(screenAdapterFor(RETINA_150))
    const d = RETINA_150.displays[0]
    expect(primaryFrameGeometry(d)).toEqual(frameOf(d))
  })
})

describe('multi-monitor', () => {
  it('a point on the right-hand 100% secondary lands right of the 150% primary', () => {
    setScreenAdapter(screenAdapterFor(DUAL_150_100))
    const second = DUAL_150_100.displays[1]
    const f = frameOf(second)
    const phys = imageToPhys(f, { x: 0, y: 0 })
    expect(phys).toEqual({ x: 2880, y: 0 })
    expect(physToLogical(phys)).toEqual({ x: 1920, y: 0 })
  })

  it('a point on the left-hand secondary keeps its negative origin', () => {
    setScreenAdapter(screenAdapterFor(DUAL_NEGATIVE))
    const second = DUAL_NEGATIVE.displays[1]
    const f = frameOf(second)
    expect(f.originX).toBe(-1920)
    const centre = imageToPhys(f, { x: f.imgW / 2, y: f.imgH / 2 })
    expect(centre).toEqual({ x: -960, y: 540 })
    expect(physToLogical(centre)).toEqual({ x: -960, y: 540 })
    const rect = physRectToLogical(imageRectToPhys(f, { x: 0, y: 0, w: 128, h: 72 }))
    expect(rect).toEqual({ x: -1920, y: 0, w: 192, h: 108 })
  })

  it('the primary of the negative layout is unaffected by the secondary', () => {
    setScreenAdapter(screenAdapterFor(DUAL_NEGATIVE))
    const primary = DUAL_NEGATIVE.displays[0]
    const f = frameOf(primary)
    expect(physToLogical(imageToPhys(f, { x: 1280, y: 800 }))).toEqual({ x: 1920, y: 1200 })
  })
})
