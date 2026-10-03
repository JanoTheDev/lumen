// Draws a model result on screen: locate boxes, guide highlights + pointer, or clears the layer.
// Every target goes through resolveTarget, so element/mark/text targets work like rects and
// the boxes land on the monitor the frame came from.
import type { GuideStep, LocateItem, ModelResponse, Rect, Target } from '@shared/types'
import { isUsableRect, rectCenter } from '../actions/coords'
import { presentCards } from '../cards'
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

/**
 * When a locate / guide target is not on screen (05 T36): how-to steps for the request, and the
 * next UI name of them that is on screen, if any. Set at startup; null = no fallback.
 */
export type HowtoFallback = (
  prompt: string,
  ctx: GroundingContext,
  signal?: AbortSignal
) => Promise<{ text: string; item?: LocateItem & { bbox: Rect } } | null>

let howtoFallback: HowtoFallback | null = null

export function setHowtoFallback(fn: HowtoFallback | null): void {
  howtoFallback = fn
}

/** The fallback's reply: the next UI name highlighted, else the steps as an answer. */
async function tryHowto(prompt: string, ctx: GroundingContext): Promise<boolean> {
  if (!howtoFallback) return false
  const r = await howtoFallback(prompt, ctx, ctx.signal).catch((e: Error) => {
    if (ctx.signal?.aborted) throw e
    log('fail', `how-to fallback: ${e.message}`)
    return null
  })
  if (!r || ctx.signal?.aborted) return false
  answer.showText(r.text)
  if (r.item) {
    highlight.send('screen:locate', [r.item])
    highlight.show()
  }
  return true
}

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

/**
 * Shows a reply. Targets resolve first; when `signal` aborts meanwhile nothing is drawn (a
 * cancelled turn never reaches the screen).
 */
export async function present(
  result: ModelResponse,
  prompt: string,
  onGuide: GuideStartFn,
  context: GroundingContext = groundingNow(),
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return
  const ctx: GroundingContext = { ...context, signal }
  try {
    await show(result, prompt, onGuide, ctx)
  } catch (e) {
    if (signal?.aborted) return
    throw e
  }
}

async function show(
  result: ModelResponse,
  prompt: string,
  onGuide: GuideStartFn,
  ctx: GroundingContext
): Promise<void> {
  const aborted = (): boolean => !!ctx.signal?.aborted
  if (result.mode === 'locate' && result.items?.length) {
    const resolved = await Promise.all(result.items.map((item) => screenRect(item, ctx)))
    if (aborted()) return
    const screenItems: (LocateItem & { bbox: Rect })[] = []
    result.items.forEach((item, i) => {
      const bbox = resolved[i]
      if (bbox) screenItems.push({ ...item, bbox })
    })
    if (screenItems.length === 0) {
      if (await tryHowto(prompt, ctx)) return
      if (aborted()) return
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
    if (aborted()) return
    const bboxSteps: GuideStep[] = []
    result.steps.forEach((s, i) => {
      const bbox = resolved[i]
      if (bbox) bboxSteps.push({ ...s, bbox })
    })
    if (!bboxSteps.length) {
      highlight.clear()
      await tryHowto(prompt, ctx)
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
  } else if (result.mode === 'answer' && result.cards) {
    highlight.clear()
    // Shown now and remembered by text, so the bar's answer:show of the same text keeps them.
    const shown = presentCards(result.text, result.cards, { request: prompt })
    if (!shown.ok) delete result.cards
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
