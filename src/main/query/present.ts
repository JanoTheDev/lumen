// Draws a model result on screen: locate boxes, guide highlights + pointer, or clears the layer.
import type { GuideStep, ModelResponse, Rect } from '@shared/types'
import {
  currentFrame,
  imageRectToPhys,
  isUsableRect,
  physRectToLogical,
  rectCenter
} from '../actions/coords'
import * as answer from '../windows/answer'
import * as highlight from '../windows/highlight'
import { setStatus } from '../windows/status'

export type GuideStartFn = (task: string, steps: GuideStep[]) => void

export function present(result: ModelResponse, prompt: string, onGuide: GuideStartFn): void {
  // Model bboxes are image px; overlays draw in logical px.
  const frame = currentFrame()
  const toScreen = (r: Rect): Rect => physRectToLogical(imageRectToPhys(frame, r))

  if (result.mode === 'locate' && result.items?.length) {
    const validItems = result.items.filter((item) => isUsableRect(item.bbox))
    if (validItems.length === 0) {
      // Nothing found on screen — show the description as an answer
      const desc = result.items[0]?.description || 'Not visible on this page'
      answer.showText(desc)
    } else {
      const screenItems = validItems.map((item) => ({ ...item, bbox: toScreen(item.bbox) }))
      highlight.send('screen:locate', screenItems)
      highlight.show()
    }
  } else if (result.mode === 'guide' && result.steps?.some((s) => s.bbox)) {
    const bboxSteps = result.steps
      .filter((s) => s.bbox)
      .map((s) => ({ ...s, bbox: s.bbox ? toScreen(s.bbox) : undefined }))
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
        (a.type === 'click_bbox' && a.bbox != null)
    )
    if (!hasRealClick) highlight.clear()
  } else {
    highlight.clear()
  }
}
