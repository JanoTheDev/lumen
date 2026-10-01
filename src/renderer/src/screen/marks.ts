// Badge layout for "show numbers" with collision avoidance (surfaces.md §3.5): start at the
// usual corner spot; if that overlaps an earlier badge, shift right or down inside the
// element; if it still overlaps, go outside to the left. O(n²) is fine for 300 marks.
import type { Rect } from '@shared/types'
import { badgeSize, placeBadge, type BadgePlace } from '../a11y/place'
import { overlaps, type Size } from './geometry'

export interface MarkBox {
  n: number
  box: Rect
}

export function cornerBox(rect: Rect, badge: Size, place: BadgePlace): Rect {
  switch (place) {
    case 'above-left':
      return { x: rect.x - 0.85 * badge.w, y: rect.y - 0.85 * badge.h, ...badge }
    case 'left':
      return { x: rect.x - badge.w, y: rect.y, ...badge }
    case 'above':
      return { x: rect.x, y: rect.y - badge.h, ...badge }
    case 'inside':
      return { x: rect.x, y: rect.y, ...badge }
  }
}

export function layoutMarks(
  marks: readonly { n: number; rect: Rect }[],
  fontPx: number,
  view: Size
): MarkBox[] {
  const out: MarkBox[] = []
  const clear = (b: Rect): boolean => out.every((o) => !overlaps(o.box, b))
  for (const m of marks) {
    const size = badgeSize(m.n, fontPx)
    const first = cornerBox(m.rect, size, placeBadge(m.rect, size, view))
    let box = first
    if (!clear(box)) {
      const tries: Rect[] = []
      for (let dx = size.w; m.rect.x + dx + size.w <= m.rect.x + m.rect.w; dx += size.w)
        tries.push({ ...size, x: m.rect.x + dx, y: m.rect.y })
      for (let dy = size.h; m.rect.y + dy + size.h <= m.rect.y + m.rect.h; dy += size.h)
        tries.push({ ...size, x: m.rect.x, y: m.rect.y + dy })
      tries.push({ ...size, x: m.rect.x - size.w - 2, y: m.rect.y })
      box = tries.find(clear) ?? first
    }
    out.push({ n: m.n, box })
  }
  return out
}
