import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { frameGeometryOf, setScreenAdapter } from '../../src/main/actions/coords'
import { cropRegion, needsRefine, refineTarget, type Crop } from '../../src/main/query/refine'
import type { ResolvedTarget } from '../../src/main/query/resolve-target'
import { display, screenAdapterFor } from '../helpers/displays'

// 150% monitor: 1 logical px = 1.5 phys px.
const LAYOUT = {
  name: '150%',
  displays: [display('m', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true)]
}

const point: ResolvedTarget = {
  physRect: { x: 964, y: 564, w: 72, h: 72 },
  logicalRect: { x: 642.67, y: 376, w: 48, h: 48 },
  monitorId: 0,
  confidence: 0.5,
  source: 'point'
}

/** A crop of `region` shown 1:1, so crop px + region origin = phys. */
function cropOf(region: { x: number; y: number; w: number; h: number }): Crop {
  return { data: 'crop', geometry: frameGeometryOf({ width: region.w, height: region.h, region }) }
}

beforeEach(() => {
  setScreenAdapter(screenAdapterFor(LAYOUT))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  setScreenAdapter(null)
  vi.restoreAllMocks()
})

describe('needsRefine', () => {
  it('refines points and low confidence, never a disabled element', () => {
    expect(needsRefine(point)).toBe(true)
    expect(needsRefine({ ...point, source: 'rect', confidence: 0.55 })).toBe(true)
    expect(needsRefine({ ...point, source: 'element', confidence: 0.95 })).toBe(false)
    expect(needsRefine({ ...point, source: 'element', confidence: 0.3, notes: ['disabled'] })).toBe(
      false
    )
  })
})

describe('cropRegion', () => {
  it('is 3x the target but at least 240 logical px, centred on it', () => {
    expect(cropRegion(point)).toEqual({ x: 820, y: 420, w: 360, h: 360 })
    const wide: ResolvedTarget = {
      ...point,
      physRect: { x: 0, y: 0, w: 600, h: 60 },
      logicalRect: { x: 0, y: 0, w: 400, h: 40 }
    }
    // 3x = 1800 phys, capped at 900 logical (1350 phys)
    expect(cropRegion(wide)).toEqual({ x: -375, y: -150, w: 1350, h: 360 })
  })
})

describe('refineTarget', () => {
  it('agreeing within 12 logical px adds 0.2', async () => {
    const r = await refineTarget(point, 'bell', undefined, {
      capture: async (region) => cropOf(region),
      // centre of the crop (1000,600) + 9 phys px = 6 logical px away
      locate: async () => ({ x: 189, y: 180 })
    })
    expect(r.outcome).toBe('agree')
    expect(r.target.confidence).toBe(0.7)
    expect(r.target.physRect).toEqual(point.physRect)
  })

  it('a different point moves the target and maps crop px back to phys', async () => {
    const r = await refineTarget(point, 'bell', undefined, {
      capture: async (region) => cropOf(region),
      locate: async () => ({ x: 300, y: 60 })
    })
    expect(r.outcome).toBe('moved')
    // crop origin (820,420) + (300,60) = (1120,480); box 24 logical = 36 phys
    expect(r.target.physRect).toEqual({ x: 1102, y: 462, w: 36, h: 36 })
    expect(r.target.logicalRect.w).toBeCloseTo(24)
    expect(r.target.confidence).toBe(0.7)
  })

  it('maps through a downscaled crop', async () => {
    const r = await refineTarget(point, 'bell', undefined, {
      capture: async (region) => ({
        data: 'c',
        geometry: frameGeometryOf({ width: region.w / 2, height: region.h / 2, region })
      }),
      locate: async () => ({ x: 150, y: 30 })
    })
    expect(r.target.physRect).toEqual({ x: 1102, y: 462, w: 36, h: 36 })
  })

  it('not found lowers confidence by 0.2', async () => {
    const r = await refineTarget(point, 'bell', undefined, {
      capture: async (region) => cropOf(region),
      locate: async () => null
    })
    expect(r.outcome).toBe('not-found')
    expect(r.target.confidence).toBe(0.3)
  })

  it('errors leave the target unchanged; an abort propagates', async () => {
    const failing = await refineTarget(point, 'bell', undefined, {
      capture: async () => {
        throw new Error('E_UNSUPPORTED')
      },
      locate: async () => null
    })
    expect(failing).toMatchObject({ outcome: 'skipped', target: point })

    const ctl = new AbortController()
    ctl.abort()
    await expect(
      refineTarget(point, 'bell', ctl.signal, {
        capture: async () => {
          throw new Error('cancelled')
        },
        locate: async () => null
      })
    ).rejects.toThrow('cancelled')
  })
})
