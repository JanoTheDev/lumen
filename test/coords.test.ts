import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import {
  frameGeometryOf,
  imageRectToPhys,
  physRectToImage,
  physToImage,
  imageToPhys,
  isUsableRect,
  logicalToPhys,
  normalizeBbox,
  physRectToLogical,
  physToLogical,
  primaryFrameGeometry,
  rectCenter,
  setScreenAdapter,
  xyxyToRect,
  type ScreenAdapter
} from '../src/main/actions/coords'

interface FakeDisplay {
  dipX: number
  dipY: number
  physX: number
  physY: number
  physW: number
  physH: number
  scale: number
}

// Emulates Windows per-monitor DPI: each display maps its phys rect onto its DIP origin.
function fakeAdapter(displays: FakeDisplay[]): ScreenAdapter {
  const byPhys = (x: number, y: number): FakeDisplay =>
    displays.find(
      (d) => x >= d.physX && x < d.physX + d.physW && y >= d.physY && y < d.physY + d.physH
    ) ?? displays[0]
  const byDip = (x: number, y: number): FakeDisplay =>
    displays.find(
      (d) =>
        x >= d.dipX &&
        x < d.dipX + d.physW / d.scale &&
        y >= d.dipY &&
        y < d.dipY + d.physH / d.scale
    ) ?? displays[0]
  const toDip = (p: { x: number; y: number }): { x: number; y: number } => {
    const d = byPhys(p.x, p.y)
    return { x: d.dipX + (p.x - d.physX) / d.scale, y: d.dipY + (p.y - d.physY) / d.scale }
  }
  return {
    screenToDipPoint: toDip,
    dipToScreenPoint: (p) => {
      const d = byDip(p.x, p.y)
      return { x: d.physX + (p.x - d.dipX) * d.scale, y: d.physY + (p.y - d.dipY) * d.scale }
    },
    screenToDipRect: (r) => {
      const d = byPhys(r.x, r.y)
      const tl = toDip(r)
      return { x: tl.x, y: tl.y, width: r.width / d.scale, height: r.height / d.scale }
    }
  }
}

const single = (scale: number): FakeDisplay => ({
  dipX: 0,
  dipY: 0,
  physX: 0,
  physY: 0,
  physW: 2560,
  physH: 1440,
  scale
})

afterEach(() => setScreenAdapter(null))

describe.each([1, 1.25, 1.5, 2])('single display at %sx scaling', (scale) => {
  const dipW = 2560 / scale
  const dipH = 1440 / scale
  const display = { bounds: { x: 0, y: 0, width: dipW, height: dipH }, scaleFactor: scale }

  it('builds frame geometry in physical px with a 1280-wide image', () => {
    setScreenAdapter(fakeAdapter([single(scale)]))
    expect(primaryFrameGeometry(display)).toEqual({
      originX: 0,
      originY: 0,
      width: 2560,
      height: 1440,
      imgW: 1280,
      imgH: 720
    })
  })

  it('maps image px to phys to logical', () => {
    setScreenAdapter(fakeAdapter([single(scale)]))
    const frame = primaryFrameGeometry(display)
    const phys = imageToPhys(frame, { x: 640, y: 360 })
    expect(phys).toEqual({ x: 1280, y: 720 })
    const logical = physToLogical(phys)
    expect(logical.x).toBeCloseTo(1280 / scale)
    expect(logical.y).toBeCloseTo(720 / scale)
    expect(logicalToPhys(logical)).toEqual(phys)
  })

  it('maps an image rect to a logical rect', () => {
    setScreenAdapter(fakeAdapter([single(scale)]))
    const frame = primaryFrameGeometry(display)
    const phys = imageRectToPhys(frame, { x: 100, y: 50, w: 200, h: 40 })
    expect(phys).toEqual({ x: 200, y: 100, w: 400, h: 80 })
    const logical = physRectToLogical(phys)
    expect(logical.x).toBeCloseTo(200 / scale)
    expect(logical.y).toBeCloseTo(100 / scale)
    expect(logical.w).toBeCloseTo(400 / scale)
    expect(logical.h).toBeCloseTo(80 / scale)
  })
})

describe('image sizing', () => {
  it('keeps the image at native size when not wider than max', () => {
    setScreenAdapter(fakeAdapter([single(1)]))
    const frame = primaryFrameGeometry({
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      scaleFactor: 1
    })
    expect(frame).toMatchObject({ width: 1280, height: 800, imgW: 1280, imgH: 800 })
    expect(imageToPhys(frame, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('downscales 2560 to 1280 and doubles coordinates back', () => {
    setScreenAdapter(fakeAdapter([single(1)]))
    const frame = primaryFrameGeometry({
      bounds: { x: 0, y: 0, width: 2560, height: 1600 },
      scaleFactor: 1
    })
    expect(frame).toMatchObject({ imgW: 1280, imgH: 800 })
    expect(imageToPhys(frame, { x: 1279, y: 799 })).toEqual({ x: 2558, y: 1598 })
  })

  it('honours a custom max width', () => {
    setScreenAdapter(fakeAdapter([single(1)]))
    const frame = primaryFrameGeometry(
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      960
    )
    expect(frame).toMatchObject({ imgW: 960, imgH: 540 })
  })
})

describe('secondary monitor with origin offset', () => {
  // Primary 2560x1440 @150% (DIP 1706.67 wide), secondary 1920x1080 @100% to its right.
  const primary: FakeDisplay = { ...single(1.5) }
  const secondary: FakeDisplay = {
    dipX: 2560 / 1.5,
    dipY: 0,
    physX: 2560,
    physY: 0,
    physW: 1920,
    physH: 1080,
    scale: 1
  }

  it('offsets image coordinates by the frame origin', () => {
    setScreenAdapter(fakeAdapter([primary, secondary]))
    const frame = {
      originX: 2560,
      originY: 0,
      width: 1920,
      height: 1080,
      imgW: 1280,
      imgH: 720
    }
    const phys = imageToPhys(frame, { x: 640, y: 360 })
    expect(phys).toEqual({ x: 2560 + 960, y: 540 })
    const logical = physToLogical(phys)
    expect(logical.x).toBeCloseTo(2560 / 1.5 + 960)
    expect(logical.y).toBeCloseTo(540)
    expect(logicalToPhys(logical).x).toBeCloseTo(phys.x)
  })

  it('derives the phys origin of a non-primary display through the adapter', () => {
    setScreenAdapter(fakeAdapter([primary, secondary]))
    const frame = primaryFrameGeometry({
      bounds: { x: 2560 / 1.5, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    })
    expect(frame).toMatchObject({ originX: 2560, originY: 0, width: 1920, height: 1080 })
  })

  it('converts a phys rect on the secondary display to logical', () => {
    setScreenAdapter(fakeAdapter([primary, secondary]))
    const logical = physRectToLogical({ x: 2660, y: 100, w: 300, h: 50 })
    expect(logical.x).toBeCloseTo(2560 / 1.5 + 100)
    expect(logical).toMatchObject({ y: 100, w: 300, h: 50 })
  })
})

describe('bbox normalization', () => {
  it('converts x1y1x2y2', () => {
    expect(xyxyToRect([10, 20, 110, 70])).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })

  it('passes {x,y,w,h} through', () => {
    expect(normalizeBbox({ x: 1, y: 2, w: 30, h: 40 })).toEqual({ x: 1, y: 2, w: 30, h: 40 })
  })

  it('reads legacy arrays as x1y1x2y2 when the second corner is past the first', () => {
    expect(normalizeBbox([100, 200, 300, 260])).toEqual({ x: 100, y: 200, w: 200, h: 60 })
  })

  it('reads legacy arrays as x,y,w,h otherwise', () => {
    expect(normalizeBbox([500, 400, 120, 30])).toEqual({ x: 500, y: 400, w: 120, h: 30 })
  })

  it('rejects malformed and empty values', () => {
    expect(normalizeBbox(null)).toBeNull()
    expect(normalizeBbox('1,2,3,4')).toBeNull()
    expect(normalizeBbox([1, 2, 3])).toBeNull()
    expect(normalizeBbox([1, 2, 'x', 4])).toBeNull()
    expect(normalizeBbox([1, 2, Number.NaN, 4])).toBeNull()
    expect(normalizeBbox({ x: 1, y: 2, w: 3 })).toBeNull()
    expect(normalizeBbox({ x: 1, y: 2, w: 0, h: 5 })).toBeNull()
    expect(normalizeBbox([50, 50, 0, 10])).toBeNull()
  })

  it('leaves tiny rects to isUsableRect', () => {
    const tiny = normalizeBbox({ x: 0, y: 0, w: 4, h: 20 })
    expect(tiny).toEqual({ x: 0, y: 0, w: 4, h: 20 })
    expect(isUsableRect(tiny)).toBe(false)
    expect(isUsableRect({ x: 0, y: 0, w: 5, h: 5 })).toBe(true)
    expect(isUsableRect({ x: 0, y: 0, w: 5, h: 5 }, 8)).toBe(false)
    expect(isUsableRect(null)).toBe(false)
  })

  it('finds the rect center', () => {
    expect(rectCenter({ x: 10, y: 20, w: 100, h: 50 })).toEqual({ x: 60, y: 45 })
  })
})

describe('frame geometry from a capture', () => {
  it('uses the monitor rect, so a 150% monitor at negative x maps image px correctly', () => {
    const g = frameGeometryOf({
      width: 1280,
      height: 800,
      monitor: { id: 0, rect: { x: -2880, y: 0, w: 2880, h: 1800 }, scale: 1.5, primary: false }
    })
    expect(g).toEqual({
      originX: -2880,
      originY: 0,
      width: 2880,
      height: 1800,
      imgW: 1280,
      imgH: 800
    })
    expect(imageToPhys(g, { x: 640, y: 400 })).toEqual({ x: -1440, y: 900 })
    expect(physToImage(g, { x: -1440, y: 900 })).toEqual({ x: 640, y: 400 })
    expect(physRectToImage(g, { x: -2880, y: 0, w: 225, h: 90 })).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 40
    })
  })

  it('prefers the captured region over the monitor rect', () => {
    const g = frameGeometryOf({
      width: 300,
      height: 300,
      region: { x: 100, y: 200, w: 300, h: 300 },
      monitor: { id: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1, primary: true }
    })
    expect(imageToPhys(g, { x: 10, y: 10 })).toEqual({ x: 110, y: 210 })
  })
})
