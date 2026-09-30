// The only place coordinate spaces are converted (CONTRACTS C4).
//   image   - pixels of the screenshot sent to the model
//   phys    - physical virtual-desktop pixels (what the agent clicks)
//   logical - Electron DIP (what overlay windows draw in)
import { screen } from 'electron'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Physical-px rect of the captured monitor plus the size of the image the model saw.
export interface FrameGeometry {
  originX: number
  originY: number
  width: number
  height: number
  imgW: number
  imgH: number
}

interface ElectronRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenAdapter {
  screenToDipPoint(pt: Point): Point
  dipToScreenPoint(pt: Point): Point
  screenToDipRect(rect: ElectronRect): ElectronRect
}

export interface DisplayLike {
  bounds: ElectronRect
  scaleFactor: number
}

export const DEFAULT_MAX_IMAGE_WIDTH = 1280

const electronAdapter: ScreenAdapter = {
  screenToDipPoint: (pt) => screen.screenToDipPoint(pt),
  dipToScreenPoint: (pt) => screen.dipToScreenPoint(pt),
  screenToDipRect: (rect) => screen.screenToDipRect(null, rect)
}

let adapter: ScreenAdapter = electronAdapter

// Pass null to restore the Electron default.
export function setScreenAdapter(next: ScreenAdapter | null): void {
  adapter = next ?? electronAdapter
}

// Today's capture: whole display in physical px, image downscaled to maxWidth.
export function primaryFrameGeometry(
  display: DisplayLike,
  maxWidth = DEFAULT_MAX_IMAGE_WIDTH
): FrameGeometry {
  const width = Math.round(display.bounds.width * display.scaleFactor)
  const height = Math.round(display.bounds.height * display.scaleFactor)
  const origin = adapter.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
  const imgW = width <= maxWidth ? width : maxWidth
  const imgH = width <= maxWidth ? height : Math.round((height * imgW) / width)
  return { originX: origin.x, originY: origin.y, width, height, imgW, imgH }
}

export function imageToPhys(frame: FrameGeometry, pt: Point): Point {
  return {
    x: Math.round(frame.originX + (pt.x * frame.width) / frame.imgW),
    y: Math.round(frame.originY + (pt.y * frame.height) / frame.imgH)
  }
}

export function imageRectToPhys(frame: FrameGeometry, rect: Rect): Rect {
  const tl = imageToPhys(frame, { x: rect.x, y: rect.y })
  const br = imageToPhys(frame, { x: rect.x + rect.w, y: rect.y + rect.h })
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
}

export function physToLogical(pt: Point): Point {
  return adapter.screenToDipPoint(pt)
}

export function logicalToPhys(pt: Point): Point {
  return adapter.dipToScreenPoint(pt)
}

export function physRectToLogical(rect: Rect): Rect {
  const r = adapter.screenToDipRect({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

export function xyxyToRect([x1, y1, x2, y2]: readonly [number, number, number, number]): Rect {
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// Accepts {x,y,w,h} or a legacy [a,b,c,d] array. Arrays are read as x1,y1,x2,y2 when
// c>a && d>b, otherwise as x,y,w,h. Returns null when malformed or not positive-sized.
export function normalizeBbox(value: unknown): Rect | null {
  let rect: Rect | null = null
  if (Array.isArray(value)) {
    if (value.length !== 4 || !value.every(isNum)) return null
    const [a, b, c, d] = value as [number, number, number, number]
    rect = c > a && d > b ? xyxyToRect([a, b, c, d]) : { x: a, y: b, w: c, h: d }
  } else if (value && typeof value === 'object') {
    const { x, y, w, h } = value as Record<string, unknown>
    if (!isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return null
    rect = { x, y, w, h }
  }
  if (!rect || rect.w <= 0 || rect.h <= 0) return null
  return rect
}

export function isUsableRect(rect: Rect | null | undefined, min = 4): rect is Rect {
  return !!rect && rect.w > min && rect.h > min
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

// Geometry of the frame the agent captures today (primary display). Replaced by the
// monitor geometry returned with each capture once the agent speaks protocol v2.
export function currentFrame(): FrameGeometry {
  return primaryFrameGeometry(screen.getPrimaryDisplay())
}
