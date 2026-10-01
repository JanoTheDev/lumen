// The vision call that names unnamed controls (11 T13): one crop per control, numbered, with
// its role and the names of the controls around it. The model gives a short accessible name,
// what the control does and how sure it is. Flat schema, every field required (both
// providers' strict modes). No Electron.
import { z } from 'zod'
import { UNTRUSTED_CONTENT_RULE } from '../ai/prompts/untrusted'

export const LABEL_SYSTEM = `You name unlabeled controls in desktop apps so blind and low-vision people can use them with a screen reader and by voice.
Each numbered image is one control (icon-only button, tab, menu item…) cut from the app, centred, with some of its surroundings.
For each control return:
- label: the name a screen reader should say, 1 to 4 words, Title case only for the first word, no role word ("Render", "Add object", "Zoom in", "Close panel"). Use the app's own wording when you know it.
- description: one short sentence about what it does, or "".
- confidence: 0 to 1. Use below 0.5 when the icon could mean several things. When you cannot tell, give label "" and confidence 0.
Never invent text you cannot see or infer from the icon and the app.
${UNTRUSTED_CONTENT_RULE}`

export const labelReplySchema = z.object({
  labels: z.array(
    z.object({
      n: z.number(),
      label: z.string(),
      description: z.string(),
      confidence: z.number()
    })
  )
})

export type LabelReply = z.infer<typeof labelReplySchema>

export interface LabelItem {
  n: number
  role: string
  /** Names of nearby controls (screen text: untrusted). */
  near: string[]
}

const fence = (s: string): string => s.replace(/[<>]/g, ' ').slice(0, 60)

export function labelTurn(app: string, windowTitle: string, items: LabelItem[]): string {
  return [
    `App: ${fence(app)}`,
    '<context>',
    `window title: ${fence(windowTitle)}`,
    ...items.map(
      (i) =>
        `image ${i.n}: role ${i.role}${i.near.length ? `; near: ${i.near.map(fence).join(', ')}` : ''}`
    ),
    '</context>',
    `Name all ${items.length} controls.`
  ].join('\n')
}

/** The reply's usable labels by item number (empty labels and bad numbers dropped). */
export function readReply(
  reply: LabelReply | null,
  count: number
): Map<number, { label: string; description: string; confidence: number }> {
  const out = new Map<number, { label: string; description: string; confidence: number }>()
  for (const l of reply?.labels ?? []) {
    const label = l.label
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.:]+$/, '')
      .slice(0, 60)
    if (!Number.isInteger(l.n) || l.n < 1 || l.n > count || !label) continue
    const confidence = Math.max(0, Math.min(1, Number.isFinite(l.confidence) ? l.confidence : 0))
    if (confidence <= 0) continue
    out.set(l.n, {
      label,
      description: l.description.replace(/\s+/g, ' ').trim().slice(0, 200),
      confidence: Math.round(confidence * 100) / 100
    })
  }
  return out
}
