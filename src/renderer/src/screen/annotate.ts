// Hand-drawn annotation shapes (surfaces.md §3.8): rough.js for arrows and circles,
// perfect-freehand for scribbles. Output is SVG path data; the seed comes from the points so
// a re-render draws the same wobble.
import rough from 'roughjs'
import { getStroke } from 'perfect-freehand'
import type { Point } from '@shared/types'

export type AnnotationKind = 'arrow' | 'circle' | 'scribble' | 'text'

export interface AnnotationShape {
  /** Stroked paths (arrows, circles). */
  strokes: string[]
  /** Filled outline (scribbles). */
  fill?: string
}

const gen = rough.generator()

export function seedOf(points: readonly Point[]): number {
  let h = 2166136261
  for (const p of points) {
    h = Math.imul(h ^ Math.round(p.x), 16777619)
    h = Math.imul(h ^ Math.round(p.y), 16777619)
  }
  return (h >>> 0) % 2 ** 31 || 1
}

function paths(d: ReturnType<typeof gen.line>): string[] {
  return gen.toPaths(d).map((p) => p.d)
}

/** Closed SVG path through a freehand outline. */
export function outlinePath(outline: number[][]): string {
  if (outline.length < 2) return ''
  const [first, ...rest] = outline
  return `M ${first[0].toFixed(1)} ${first[1].toFixed(1)} ${rest.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')} Z`
}

export function shapeFor(kind: AnnotationKind, points: readonly Point[]): AnnotationShape {
  const seed = seedOf(points)
  const opts = { roughness: 1.2, bowing: 1, seed, disableMultiStroke: true, preserveVertices: true }
  if (kind === 'arrow' && points.length >= 2) {
    const [a, b] = points
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    // A slight curve: bend the middle sideways by 8% of the length.
    const nx = -(b.y - a.y) / len
    const ny = (b.x - a.x) / len
    const mid: [number, number] = [
      (a.x + b.x) / 2 + nx * len * 0.08,
      (a.y + b.y) / 2 + ny * len * 0.08
    ]
    const shaft = gen.curve([[a.x, a.y], mid, [b.x, b.y]], opts)
    // Head: two strokes back from the tip, angled 28° off the final direction.
    const dir = Math.atan2(b.y - mid[1], b.x - mid[0])
    const head = Math.min(22, len * 0.35)
    const wing = (s: number): [number, number] => [
      b.x - head * Math.cos(dir + s * 0.49),
      b.y - head * Math.sin(dir + s * 0.49)
    ]
    const left = wing(1)
    const right = wing(-1)
    return {
      strokes: [
        ...paths(shaft),
        ...paths(gen.line(b.x, b.y, left[0], left[1], opts)),
        ...paths(gen.line(b.x, b.y, right[0], right[1], opts))
      ]
    }
  }
  if (kind === 'circle' && points.length >= 1) {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const x0 = Math.min(...xs) - 8
    const y0 = Math.min(...ys) - 8
    const w = Math.max(...xs) - Math.min(...xs) + 16
    const h = Math.max(...ys) - Math.min(...ys) + 16
    return { strokes: paths(gen.ellipse(x0 + w / 2, y0 + h / 2, w, h, opts)) }
  }
  if (kind === 'scribble' && points.length >= 1) {
    const outline = getStroke(
      points.map((p) => [p.x, p.y]),
      { size: 7, thinning: 0.55, smoothing: 0.5, streamline: 0.5 }
    )
    return { strokes: [], fill: outlinePath(outline) }
  }
  return { strokes: [] }
}
