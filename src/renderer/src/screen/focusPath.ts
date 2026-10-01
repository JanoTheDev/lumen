// Focus mode mask path (11 T14): the view as one rect with every kept rect cut out (evenodd).
// Kept rects are clamped to the view; overlapping ones are merged first so they stay holes.
import type { Rect } from '@shared/types'
import type { Size } from './geometry'

const rectPath = (r: Rect): string => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`

function clampTo(r: Rect, view: Size): Rect | null {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  const w = Math.min(view.w, r.x + r.w) - x
  const h = Math.min(view.h, r.y + r.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Overlapping rects become their bounding box (evenodd would turn the overlap dark again). */
export function mergeOverlapping(rects: Rect[]): Rect[] {
  const out = [...rects]
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (touches(out[i], out[j])) {
          out[i] = union(out[i], out[j])
          out.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return out
}

export function focusPath(keep: Rect[], view: Size): string {
  const holes = mergeOverlapping(
    keep.map((r) => clampTo(r, view)).filter((r): r is Rect => r !== null)
  )
  return [rectPath({ x: 0, y: 0, w: view.w, h: view.h }), ...holes.map(rectPath)].join('')
}
