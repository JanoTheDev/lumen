// Shared a11y hooks (06 T16) for every renderer. They follow both the OS setting and Lumen's
// own override (data-reduce-motion / root font size written by theme/apply.ts) and update
// live when either changes.
import { useSyncExternalStore } from 'react'
import { prefersReducedMotion } from '../ui/motion'

const BASE_FONT_PX = 16

/** Calls `cb` on any of the media queries changing or the root's theme attributes changing. */
function subscribe(queries: string[], cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const lists = queries.map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m)
  lists.forEach((m) => m.addEventListener('change', cb))
  const mo =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(cb)
      : { observe: () => {}, disconnect: () => {} }
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduce-motion', 'data-theme', 'style']
  })
  return () => {
    lists.forEach((m) => m.removeEventListener('change', cb))
    mo.disconnect()
  }
}

const REDUCED = ['(prefers-reduced-motion: reduce)']
const FORCED = ['(forced-colors: active)']

/** Reduced motion: Lumen's setting when it is on/off, else the Windows animation setting. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => subscribe(REDUCED, cb),
    prefersReducedMotion,
    () => false
  )
}

export function forcedColorsActive(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(FORCED[0]).matches
}

/** Windows contrast theme on: CSS uses system colours, custom colours must step aside. */
export function useForcedColors(): boolean {
  return useSyncExternalStore(
    (cb) => subscribe(FORCED, cb),
    forcedColorsActive,
    () => false
  )
}

/** Root font size over the 16px base: a11y.uiScale × Windows text size (1 when zoomed by main). */
export function uiScaleNow(): number {
  if (typeof document === 'undefined') return 1
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px / BASE_FONT_PX : 1
}

export function useUiScale(): number {
  return useSyncExternalStore(
    (cb) => subscribe([], cb),
    uiScaleNow,
    () => 1
  )
}
