// Label pill sizing and placement. Pills sit beside their anchor rect and avoid the screen
// edges, the highlighted targets and each other, so a label never covers a guide box.
import type { Rect } from '@shared/types'
import { clampRect, inside, overlapArea, type Size } from './geometry'

const GAP = 8

/** Pill box estimate: --text-md 600 with 6/10 padding, max 22rem wide, at most 2 lines. */
export function pillSize(text: string, fontPx: number): Size {
  const maxW = 22 * fontPx
  const padX = 10
  const padY = 6
  const textW = text.length * fontPx * 0.56
  const lines = Math.min(2, Math.max(1, Math.ceil(textW / (maxW - 2 * padX))))
  const w = Math.min(maxW, Math.ceil(textW + 2 * padX))
  const h = Math.ceil(lines * fontPx * 1.3 + 2 * padY)
  return { w, h }
}

export type Side = 'below' | 'above' | 'right' | 'left'

export function candidate(anchor: Rect, size: Size, side: Side): Rect {
  switch (side) {
    case 'below':
      return { x: anchor.x, y: anchor.y + anchor.h + GAP, ...size }
    case 'above':
      return { x: anchor.x, y: anchor.y - GAP - size.h, ...size }
    case 'right':
      return { x: anchor.x + anchor.w + GAP, y: anchor.y + (anchor.h - size.h) / 2, ...size }
    case 'left':
      return { x: anchor.x - GAP - size.w, y: anchor.y + (anchor.h - size.h) / 2, ...size }
  }
}

export interface LabelRequest {
  id: string
  anchor: Rect
  size: Size
  /** Sides to try, best first. */
  prefer?: Side[]
}

const ALL_SIDES: Side[] = ['below', 'above', 'right', 'left']

/**
 * Places labels in order. Each takes the first preferred side that is on screen and clear
 * of the obstacles and earlier labels; failing that, the side with the least overlap,
 * pulled back on screen.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  obstacles: readonly Rect[],
  view: Size
): Map<string, Rect> {
  const placed = new Map<string, Rect>()
  const taken: Rect[] = []
  for (const req of requests) {
    const sides = [...(req.prefer ?? []), ...ALL_SIDES.filter((s) => !req.prefer?.includes(s))]
    let best: Rect | null = null
    let bestCost = Infinity
    for (const side of sides) {
      const raw = candidate(req.anchor, req.size, side)
      const box = inside(raw, view) ? raw : clampRect(raw, view, 4)
      const blockers = [...obstacles, ...taken]
      let cost = blockers.reduce((sum, o) => sum + overlapArea(box, o), 0)
      // Pulling a pill back on screen is fine, but a clean fit wins.
      if (box !== raw) cost += 1
      if (cost < bestCost) {
        best = box
        bestCost = cost
      }
      if (cost === 0) break
    }
    if (best) {
      placed.set(req.id, best)
      taken.push(best)
    }
  }
  return placed
}
