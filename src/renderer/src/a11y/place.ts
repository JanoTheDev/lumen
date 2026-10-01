// Badge placement for the numbers overlay: outside the target's top-left corner when it
// fits, so the badge does not cover the control's label.
import type { Rect } from '@shared/types'

export type BadgePlace = 'above-left' | 'left' | 'above' | 'inside'

/** Badge box estimate in px: height about 1.6em, width grows with the digits. */
export function badgeSize(n: number, fontPx: number): { w: number; h: number } {
  const digits = String(n).length
  return { w: fontPx * (0.9 + 0.62 * digits), h: fontPx * 1.6 }
}

/** Outside top-left when it fits, else beside, above, or inside the target. */
export function placeBadge(
  rect: Rect,
  badge: { w: number; h: number },
  view: { w: number; h: number }
): BadgePlace {
  const roomAbove = rect.y >= badge.h
  const roomLeft = rect.x >= badge.w
  if (roomAbove && roomLeft) return 'above-left'
  if (roomLeft) return 'left'
  if (roomAbove && rect.x + badge.w <= view.w) return 'above'
  return 'inside'
}

// Switch scanning menu panel (06 T09).
const MENU_GAP = 24
export const MENU_EDGE = 8

/** Menu box near `at`, below-right, flipped and clamped so it stays on screen. */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  view: { w: number; h: number }
): { x: number; y: number } {
  let x = at.x + MENU_GAP
  let y = at.y + MENU_GAP
  if (x + size.w > view.w - MENU_EDGE) x = at.x - MENU_GAP - size.w
  if (y + size.h > view.h - MENU_EDGE) y = at.y - MENU_GAP - size.h
  return {
    x: Math.max(MENU_EDGE, Math.min(x, view.w - size.w - MENU_EDGE)),
    y: Math.max(MENU_EDGE, Math.min(y, view.h - size.h - MENU_EDGE))
  }
}
