// Focus mode geometry (11 T14), pure: which rects stay clear, which pack regions are hidden
// (strong level labels them), and "focus on the viewport" region matching. Rects are in one
// coordinate space throughout (the caller converts physical → logical before or after).
import type { FocusScene } from '@shared/events'
import type { Rect } from '@shared/types'

export interface NamedRegion {
  name: string
  desc: string
  rect: Rect
}

/** Space left around a kept rect so its border and focus ring stay readable. */
export const KEEP_PAD = 8
const MIN_SIDE = 4

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by
})

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Rect of a pack region (fractions of the window) inside `win`. */
export function regionToRect(win: Rect, r: { x: number; y: number; w: number; h: number }): Rect {
  return { x: win.x + r.x * win.w, y: win.y + r.y * win.h, w: r.w * win.w, h: r.h * win.h }
}

/** Pack regions as rects inside `win`. */
export function packRegions(
  win: Rect,
  regions: Record<string, { x: number; y: number; w: number; h: number; desc?: string }>
): NamedRegion[] {
  return Object.entries(regions).map(([name, r]) => ({
    name,
    desc: r.desc ?? name,
    rect: regionToRect(win, r)
  }))
}

/** A short label for a hidden region: the description up to its first comma. */
export function shortLabel(desc: string): string {
  const head = desc.split(/[,(]/)[0].trim()
  return head.length > 40 ? `${head.slice(0, 39)}…` : head
}

/**
 * Regions that are mostly (more than half) outside every kept rect: those are dimmed, and
 * strong focus labels them so the user knows what is behind the dim.
 */
export function hiddenRegions(regions: NamedRegion[], keep: Rect[]): NamedRegion[] {
  return regions.filter((r) => {
    const area = r.rect.w * r.rect.h
    if (area <= 0) return false
    const covered = keep.reduce((sum, k) => sum + overlapArea(r.rect, k), 0)
    return covered / area < 0.5
  })
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))

const STOP = new Set(['the', 'and', 'panel', 'area', 'top', 'bottom', 'left', 'right', 'with'])

/**
 * Regions the user named ("the viewport and the properties"): a region matches when its id
 * or description shares a word with the request. Best matches first.
 */
export function matchRegions(query: string, regions: NamedRegion[]): NamedRegion[] {
  const q = new Set(words(query))
  if (!q.size) return []
  const scored = regions
    .map((r) => {
      const id = words(r.name.replace(/-/g, ' '))
      const desc = words(r.desc)
      const score = id.filter((w) => q.has(w)).length * 2 + desc.filter((w) => q.has(w)).length
      return { r, score }
    })
    .filter((s) => s.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.r)
}

/** The scene the screen layer draws; null when there is nothing to keep clear. */
export function buildFocusScene(
  level: FocusScene['level'],
  keep: Rect[],
  regions: NamedRegion[] = []
): FocusScene | null {
  const clear = keep
    .filter((r) => r.w >= MIN_SIDE && r.h >= MIN_SIDE)
    .map((r) => inflate(r, KEEP_PAD))
  if (!clear.length) return null
  const scene: FocusScene = { level, keep: clear }
  if (level === 'strong') {
    const labels = hiddenRegions(regions, clear)
      .filter((r) => r.rect.w >= 60 && r.rect.h >= 24)
      .map((r) => ({ rect: r.rect, text: `Hidden: ${shortLabel(r.desc)}` }))
    if (labels.length) scene.labels = labels
  }
  return scene
}
