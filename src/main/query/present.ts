// Draws a model result on screen: locate boxes, guide highlights + pointer, or clears the layer.
// Every target goes through resolveTarget, so element/mark/text targets work like rects and
// the boxes land on the monitor the frame came from.
import type { GuideStep, LocateItem, ModelResponse, Rect, Target } from '@shared/types'
import { isUsableRect, rectCenter } from '../actions/coords'
import { log } from '../logger'
import * as answer from '../windows/answer'
import * as highlight from '../windows/highlight'
import { setStatus } from '../windows/status'
import {
  describeResolved,
  groundingNow,
  resolveTarget,
  type GroundingContext
} from './resolve-target'

export type GuideStartFn = (task: string, steps: GuideStep[]) => void

/** The target of a reply item: its own, else the legacy image-px bbox as a rect. */
function targetOf(item: { target?: Target; bbox?: Rect }): Target | null {
  if (item.target) return item.target
  if (item.bbox) return { kind: 'rect', ...item.bbox, frame: '1' }
  return null
}

/** The logical-px rect of an item, or null when it cannot be found on screen. */
async function screenRect(
  item: { target?: Target; bbox?: Rect; label?: string },
  ctx: GroundingContext
): Promise<Rect | null> {
  const t = targetOf(item)
  if (!t) return null
  const r = await resolveTarget(t, ctx)
  if (r) log('plan', `target "${(item.label ?? '').slice(0, 40)}": ${describeResolved(r)}`)
  else log('fail', `target "${(item.label ?? '').slice(0, 40)}" (${t.kind}) not found on screen`)
  return r && isUsableRect(r.logicalRect) ? r.logicalRect : null
}

export async function present(
  result: ModelResponse,
  prompt: string,
  onGuide: GuideStartFn,
  ctx: GroundingContext = groundingNow()
): Promise<void> {
  if (result.mode === 'locate' && result.items?.length) {
    const resolved = await Promise.all(result.items.map((item) => screenRect(item, ctx)))
    const screenItems: (LocateItem & { bbox: Rect })[] = []
    result.items.forEach((item, i) => {
      const bbox = resolved[i]
      if (bbox) screenItems.push({ ...item, bbox })
    })
    if (screenItems.length === 0) {
      // Nothing found on screen — show the description as an answer
      const desc =
        result.notFoundReason || result.items[0]?.description || 'Not visible on this page'
      answer.showText(desc)
    } else {
      highlight.send('screen:locate', screenItems)
      highlight.show()
    }
  } else if (result.mode === 'guide' && result.steps?.some((s) => s.bbox || s.target)) {
    const resolved = await Promise.all(result.steps.map((s) => screenRect(s, ctx)))
    const bboxSteps: GuideStep[] = []
    result.steps.forEach((s, i) => {
      const bbox = resolved[i]
      if (bbox) bboxSteps.push({ ...s, bbox })
    })
    if (!bboxSteps.length) {
      highlight.clear()
      return
    }
    onGuide(prompt, bboxSteps)
    setStatus('step', bboxSteps[0]?.label ?? 'Guide ready', { index: 1, total: bboxSteps.length })
    highlight.send('screen:highlights', bboxSteps)
    highlight.show()

    // Draw the pointer only; moving the real cursor could dismiss the guide.
    const first = bboxSteps[0]
    if (first?.bbox) {
      const c = rectCenter(first.bbox)
      highlight.send('screen:pointer', {
        x: Math.round(c.x),
        y: Math.round(c.y),
        text: `1/${bboxSteps.length}: ${first.label || first.target_hint}`
      })
    }
  } else if (result.mode === 'action') {
    const hasRealClick = result.actions?.some(
      (a) =>
        ((a.type === 'click' || a.type === 'move') && a.x != null && a.y != null) ||
        (a.type === 'click_bbox' && a.bbox != null) ||
        a.type === 'click_target'
    )
    if (!hasRealClick) highlight.clear()
  } else {
    highlight.clear()
  }
}
