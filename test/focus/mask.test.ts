import { describe, expect, it } from 'vitest'
import {
  buildFocusScene,
  hiddenRegions,
  KEEP_PAD,
  matchRegions,
  packRegions,
  shortLabel
} from '../../src/main/focus/mask'
import { focusPath, mergeOverlapping } from '../../src/renderer/src/screen/focusPath'

const win = { x: 100, y: 50, w: 1000, h: 800 }
const regions = packRegions(win, {
  viewport: { x: 0.2, y: 0.05, w: 0.6, h: 0.7, desc: '3D Viewport, the big centre area' },
  outliner: { x: 0.8, y: 0.05, w: 0.2, h: 0.3, desc: 'Outliner (scene objects), top right' },
  properties: { x: 0.8, y: 0.35, w: 0.2, h: 0.6, desc: 'Properties editor, right side' },
  'top-menus': { x: 0, y: 0, w: 0.14, h: 0.02, desc: 'File, Edit, Render menus' }
})

describe('focus mask', () => {
  it('maps pack regions into the window', () => {
    expect(regions[0].rect).toEqual({ x: 300, y: 90, w: 600, h: 560 })
  })

  it('matches named regions by id and description words', () => {
    expect(matchRegions('the viewport', regions).map((r) => r.name)).toEqual(['viewport'])
    expect(
      matchRegions('properties and outliner', regions)
        .map((r) => r.name)
        .sort()
    ).toEqual(['outliner', 'properties'])
    expect(matchRegions('scene objects', regions)[0].name).toBe('outliner')
    expect(matchRegions('timeline', regions)).toEqual([])
  })

  it('soft focus keeps the padded rects clear and has no labels', () => {
    const s = buildFocusScene('soft', [regions[0].rect], regions)!
    expect(s.level).toBe('soft')
    expect(s.keep[0]).toEqual({ x: 300 - KEEP_PAD, y: 90 - KEEP_PAD, w: 616, h: 576 })
    expect(s.labels).toBeUndefined()
  })

  it('strong focus labels the big hidden regions only', () => {
    const s = buildFocusScene('strong', [regions[0].rect], regions)!
    expect(s.labels?.map((l) => l.text)).toEqual(['Hidden: Outliner', 'Hidden: Properties editor'])
  })

  it('nothing to keep → no scene', () => {
    expect(buildFocusScene('soft', [{ x: 0, y: 0, w: 2, h: 2 }])).toBeNull()
  })

  it('hidden regions are the ones mostly outside every kept rect', () => {
    const keep = [regions[1].rect]
    expect(hiddenRegions(regions, keep).map((r) => r.name)).toEqual([
      'viewport',
      'properties',
      'top-menus'
    ])
  })

  it('short labels cut at a comma or bracket', () => {
    expect(shortLabel('Outliner (scene objects), top right')).toBe('Outliner')
  })
})

describe('focus path (renderer)', () => {
  it('cuts each kept rect out of the view', () => {
    expect(focusPath([{ x: 10, y: 10, w: 20, h: 20 }], { w: 100, h: 50 })).toBe(
      'M0 0h100v50h-100zM10 10h20v20h-20z'
    )
  })

  it('merges overlapping holes so the overlap stays clear', () => {
    expect(
      mergeOverlapping([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 5, y: 5, w: 10, h: 10 },
        { x: 50, y: 50, w: 5, h: 5 }
      ])
    ).toEqual([
      { x: 0, y: 0, w: 15, h: 15 },
      { x: 50, y: 50, w: 5, h: 5 }
    ])
  })

  it('clamps holes to the view and drops ones outside it', () => {
    expect(
      focusPath(
        [
          { x: -10, y: -10, w: 30, h: 30 },
          { x: 500, y: 0, w: 10, h: 10 }
        ],
        { w: 100, h: 50 }
      )
    ).toBe('M0 0h100v50h-100zM0 0h20v20h-20z')
  })
})
