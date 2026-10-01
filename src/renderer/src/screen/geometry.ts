// Rect helpers for the screen layer. Everything is in this display's DIP (CONTRACTS C4).
import type { Point, Rect } from '@shared/types'

export interface Size {
  w: number
  h: number
}

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by
})

export const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export function inside(r: Rect, view: Size): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= view.w && r.y + r.h <= view.h
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** Moves `r` the least amount needed to sit fully inside the view (with `margin`). */
export function clampRect(r: Rect, view: Size, margin = 0): Rect {
  const x = Math.max(margin, Math.min(r.x, view.w - r.w - margin))
  const y = Math.max(margin, Math.min(r.y, view.h - r.h - margin))
  return { ...r, x, y }
}

export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)
