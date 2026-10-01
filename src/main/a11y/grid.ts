// Mouse grid (06 T07): a recursive 3×3 grid on one monitor, like Voice Access "mousegrid".
// Saying 1–9 zooms into that cell until it is 20 px or smaller; "back" goes up a level;
// "drag" remembers the centre, the next selection + "drop" finishes the drag. Logical px.
import type { Point, Rect } from '@shared/types'

export const GRID_COLS = 3
export const GRID_ROWS = 3
export const MIN_CELL_PX = 20

export interface GridScene {
  rect: Rect
  cols: number
  rows: number
  level: number
}

export function cellRect(rect: Rect, n: number, cols = GRID_COLS, rows = GRID_ROWS): Rect {
  const i = n - 1
  const col = i % cols
  const row = Math.floor(i / cols)
  const w = rect.w / cols
  const h = rect.h / rows
  return { x: rect.x + col * w, y: rect.y + row * h, w, h }
}

export function center(r: Rect): Point {
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }
}

export class MouseGrid {
  private stack: Rect[] = []
  monitorId: number | null = null
  dragFrom: Point | null = null

  get shown(): boolean {
    return this.stack.length > 0
  }

  get rect(): Rect | null {
    return this.stack[this.stack.length - 1] ?? null
  }

  get level(): number {
    return this.stack.length - 1
  }

  /** Smallest cell reached: further numbers do nothing. */
  get atMinimum(): boolean {
    const r = this.rect
    return !!r && r.w <= MIN_CELL_PX && r.h <= MIN_CELL_PX
  }

  show(bounds: Rect, monitorId: number): void {
    this.stack = [bounds]
    this.monitorId = monitorId
    this.dragFrom = null
  }

  /** Zooms into cell n (1–9). False when out of range or already at the smallest size. */
  select(n: number): boolean {
    const r = this.rect
    if (!r || n < 1 || n > GRID_COLS * GRID_ROWS || this.atMinimum) return false
    this.stack.push(cellRect(r, n))
    return true
  }

  /** One level up; false at the top. */
  up(): boolean {
    if (this.stack.length <= 1) return false
    this.stack.pop()
    return true
  }

  target(): Point | null {
    const r = this.rect
    return r ? center(r) : null
  }

  /** Remembers the drag start and resets to the whole monitor to pick the drop point. */
  markDrag(): Point | null {
    const p = this.target()
    if (!p) return null
    this.dragFrom = p
    this.stack = this.stack.slice(0, 1)
    return p
  }

  /** Completes the drag: start and end points, then the grid closes. */
  drop(): { from: Point; to: Point } | null {
    const to = this.target()
    if (!to || !this.dragFrom) return null
    const from = this.dragFrom
    this.close()
    return { from, to }
  }

  close(): void {
    this.stack = []
    this.monitorId = null
    this.dragFrom = null
  }

  scene(): GridScene | undefined {
    const r = this.rect
    return r ? { rect: r, cols: GRID_COLS, rows: GRID_ROWS, level: this.level } : undefined
  }
}
