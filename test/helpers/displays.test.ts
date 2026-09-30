import { describe, it, expect, afterEach } from 'vitest'
import { ALL_LAYOUTS, DUAL_NEGATIVE, RETINA_150, primaryOf, screenAdapterFor } from './displays'
import {
  imageToPhys,
  logicalToPhys,
  physToLogical,
  primaryFrameGeometry,
  setScreenAdapter
} from '../../src/main/actions/coords'

describe('displays helper', () => {
  afterEach(() => setScreenAdapter(null))

  it('150% primary maps a 1280-wide image to 2880 physical px', () => {
    setScreenAdapter(screenAdapterFor(RETINA_150))
    const frame = primaryFrameGeometry(primaryOf(RETINA_150))
    expect(frame).toMatchObject({ width: 2880, height: 1800, imgW: 1280, imgH: 800 })
    expect(imageToPhys(frame, { x: 640, y: 400 })).toEqual({ x: 1440, y: 900 })
  })

  it.each(ALL_LAYOUTS.map((l) => [l.name, l] as const))(
    'phys -> logical -> phys round-trips on every display (%s)',
    (_name, layout) => {
      setScreenAdapter(screenAdapterFor(layout))
      for (const d of layout.displays) {
        const p = { x: d.physBounds.x + 101, y: d.physBounds.y + 57 }
        const back = logicalToPhys(physToLogical(p))
        expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(1)
      }
    }
  )

  it('negative-origin secondary stays negative in DIP', () => {
    setScreenAdapter(screenAdapterFor(DUAL_NEGATIVE))
    expect(physToLogical({ x: -1000, y: 10 })).toEqual({ x: -1000, y: 10 })
    expect(physToLogical({ x: 1500, y: 300 })).toEqual({ x: 1000, y: 200 })
  })
})
