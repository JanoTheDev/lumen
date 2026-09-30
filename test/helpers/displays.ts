// Display fixtures with Windows per-monitor DPI semantics:
//   bounds     - Electron DIP rect (what screen.getAllDisplays() reports)
//   physBounds - physical pixel rect on the virtual desktop (what the agent clicks)
import type { DisplayLike, ScreenAdapter } from '../../src/main/actions/coords'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TestDisplay extends DisplayLike {
  id: number
  label: string
  bounds: Rect
  physBounds: Rect
  scaleFactor: number
  primary: boolean
}

export interface DisplayLayout {
  name: string
  displays: TestDisplay[]
}

let nextId = 1

export function display(
  label: string,
  phys: Rect,
  scaleFactor: number,
  dipOrigin: { x: number; y: number },
  primary = false
): TestDisplay {
  return {
    id: nextId++,
    label,
    scaleFactor,
    primary,
    physBounds: phys,
    bounds: {
      x: dipOrigin.x,
      y: dipOrigin.y,
      width: Math.round(phys.width / scaleFactor),
      height: Math.round(phys.height / scaleFactor)
    }
  }
}

const single = (label: string, w: number, h: number, scale: number): DisplayLayout => ({
  name: label,
  displays: [display(label, { x: 0, y: 0, width: w, height: h }, scale, { x: 0, y: 0 }, true)]
})

export const FHD_100 = single('1920x1080@100%', 1920, 1080, 1)
export const QHD_125 = single('2560x1440@125%', 2560, 1440, 1.25)
export const RETINA_150 = single('2880x1800@150%', 2880, 1800, 1.5)
export const UHD_200 = single('3840x2160@200%', 3840, 2160, 2)

export const SINGLE_LAYOUTS = [FHD_100, QHD_125, RETINA_150, UHD_200]

/** Primary 150% at 0,0; secondary 100% to its right (DIP x=1920, physical x=2880). */
export const DUAL_150_100: DisplayLayout = {
  name: 'dual 150% + 100% right',
  displays: [
    display('primary', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true),
    display('secondary', { x: 2880, y: 0, width: 1920, height: 1080 }, 1, { x: 1920, y: 0 })
  ]
}

/** Primary 150% at 0,0; secondary 100% to its left, so it has a negative origin. */
export const DUAL_NEGATIVE: DisplayLayout = {
  name: 'dual 150% + 100% left (negative origin)',
  displays: [
    display('primary', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true),
    display('secondary', { x: -1920, y: 0, width: 1920, height: 1080 }, 1, { x: -1920, y: 0 })
  ]
}

export const ALL_LAYOUTS = [...SINGLE_LAYOUTS, DUAL_150_100, DUAL_NEGATIVE]

export function primaryOf(layout: DisplayLayout): TestDisplay {
  return layout.displays.find((d) => d.primary) ?? layout.displays[0]
}

const inside = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height

function byPhys(layout: DisplayLayout, x: number, y: number): TestDisplay {
  return layout.displays.find((d) => inside(d.physBounds, x, y)) ?? primaryOf(layout)
}

function byDip(layout: DisplayLayout, x: number, y: number): TestDisplay {
  return layout.displays.find((d) => inside(d.bounds, x, y)) ?? primaryOf(layout)
}

/** DIP <-> physical conversions for a layout, like Electron's screen API on Windows. */
export function screenAdapterFor(layout: DisplayLayout): ScreenAdapter & {
  getPrimaryDisplay: () => TestDisplay
  getAllDisplays: () => TestDisplay[]
  getDisplayNearestPoint: (pt: { x: number; y: number }) => TestDisplay
} {
  const toDip = (pt: { x: number; y: number }): { x: number; y: number } => {
    const d = byPhys(layout, pt.x, pt.y)
    return {
      x: d.bounds.x + (pt.x - d.physBounds.x) / d.scaleFactor,
      y: d.bounds.y + (pt.y - d.physBounds.y) / d.scaleFactor
    }
  }
  const toPhys = (pt: { x: number; y: number }): { x: number; y: number } => {
    const d = byDip(layout, pt.x, pt.y)
    return {
      x: Math.round(d.physBounds.x + (pt.x - d.bounds.x) * d.scaleFactor),
      y: Math.round(d.physBounds.y + (pt.y - d.bounds.y) * d.scaleFactor)
    }
  }
  return {
    screenToDipPoint: toDip,
    dipToScreenPoint: toPhys,
    screenToDipRect: (r) => {
      const d = byPhys(layout, r.x, r.y)
      const o = toDip(r)
      return { x: o.x, y: o.y, width: r.width / d.scaleFactor, height: r.height / d.scaleFactor }
    },
    getPrimaryDisplay: () => primaryOf(layout),
    getAllDisplays: () => layout.displays,
    getDisplayNearestPoint: (pt) => byDip(layout, pt.x, pt.y)
  }
}
