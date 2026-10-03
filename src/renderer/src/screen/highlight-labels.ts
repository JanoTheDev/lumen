// Where the highlight rings and their label pills sit, shared by the highlight layer and the
// buddy (whose own label must not cover a highlight's).
import type { ScreenScene } from '@shared/events'
import type { Rect } from '@shared/types'
import type { Present } from './scene'
import { showHighlightLabel } from './scene'
import { center, inflate, type Size } from './geometry'
import { pillSize, placeLabels } from './labels'

export type Highlight = ScreenScene['highlights'][number]

const RING_PAD = 6
const HOLE_PAD = 8

export function ringRect(h: Highlight, fontPx: number): Rect {
  if (h.style === 'ring') {
    const d = 2.5 * fontPx
    const c = center(h.rect)
    return { x: c.x - d / 2, y: c.y - d / 2, w: d, h: d }
  }
  return inflate(h.rect, h.style === 'dim-reveal' ? HOLE_PAD : RING_PAD)
}

interface LabelInput {
  list: Present<Highlight>[]
  buddyLabel?: string
  view: Size
  fontPx: number
}

/** Where each highlight's label pill goes, by highlight key (the buddy's label avoids these). */
export function placeHighlightLabels({
  list,
  buddyLabel,
  view,
  fontPx
}: LabelInput): Map<string, Rect> {
  const rings = list.map((p) => ({ p, r: ringRect(p.item, fontPx) }))
  const badge = 1.5 * fontPx
  const requests = rings
    .filter(({ p }) => showHighlightLabel(p.item.label, buddyLabel))
    .map(({ p, r }) => ({
      id: p.key,
      anchor: p.item.n != null ? { x: r.x, y: r.y - badge / 2, w: r.w, h: r.h + badge / 2 } : r,
      size: pillSize(p.item.label!, Math.max(14, fontPx))
    }))
  return placeLabels(
    requests,
    rings.map((x) => x.r),
    view
  )
}

/** What the buddy and its label keep clear of: other highlights and every highlight's pill. */
export function buddyAvoid(
  live: readonly Highlight[],
  targetRect: Rect | undefined,
  placed: Map<string, Rect>
): Rect[] {
  return [...live.map((h) => h.rect).filter((r) => r !== targetRect), ...placed.values()]
}
