// Reply schemas per mode (CONTRACTS C3/C4) and the adapter to the ModelResponse shape the
// pipeline, presenter, renderer and executor consume until the target resolver (T13) lands.
// Absent fields are `.optional()`, never nullable: see providers/structured.ts.
import { z } from 'zod'
import type { Action, GuideStep, LocateItem, ModelResponse, Rect, Target } from '@shared/types'
import { parseJsonAs } from './json'
import { isBrowser } from './app-context'

const num = z.number()

export const rectSchema = z.object({ x: num, y: num, w: num, h: num })

export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('element'), id: z.string() }),
  z.object({ kind: z.literal('mark'), n: num }),
  z.object({ kind: z.literal('text'), text: z.string(), nth: num.optional() }),
  z.object({ kind: z.literal('point'), x: num, y: num, frame: z.string() }),
  z.object({ kind: z.literal('rect'), x: num, y: num, w: num, h: num, frame: z.string() }),
  z.object({ kind: z.literal('region'), name: z.string() })
])

const button = z.enum(['left', 'right']).optional()

/** The model-facing subset of the shared Action union (URLs only via open_url). */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: num, y: num, button }),
  z.object({
    type: z.literal('click_target'),
    target: targetSchema,
    button,
    description: z.string().optional()
  }),
  z.object({
    type: z.literal('click_bbox'),
    bbox: rectSchema,
    button,
    description: z.string().optional()
  }),
  z.object({
    type: z.literal('click_element'),
    text: z.string(),
    button,
    bbox: rectSchema.optional()
  }),
  z.object({ type: z.literal('click_nth_element'), text: z.string(), n: num, button }),
  z.object({ type: z.literal('move'), x: num, y: num }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({ type: z.literal('hotkey'), keys: z.array(z.string()) }),
  z.object({ type: z.literal('open_url'), url: z.string() }),
  z.object({ type: z.literal('focus_browser') }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: num.optional()
  })
])

export const answerSchema = z.object({
  mode: z.literal('answer'),
  spoken: z.string(),
  markdown: z.string().optional(),
  point: targetSchema.optional()
})

export const guideSchema = z.object({
  mode: z.literal('guide'),
  steps: z.array(
    z.object({ label: z.string(), target: targetSchema.optional(), detail: z.string().optional() })
  )
})

export const locateSchema = z.object({
  mode: z.literal('locate'),
  items: z.array(z.object({ label: z.string(), target: targetSchema })),
  notFoundReason: z.string().optional()
})

export const actionModeSchema = z.object({
  mode: z.literal('action'),
  summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  actions: z.array(actionSchema),
  followUp: z.string().optional()
})

export const textInsertSchema = z.object({
  mode: z.literal('text_insert'),
  text: z.string(),
  targetField: targetSchema.optional()
})

export const clarifySchema = z.object({ mode: z.literal('clarify'), question: z.string() })

export const modeReplySchema = z.discriminatedUnion('mode', [
  answerSchema,
  guideSchema,
  locateSchema,
  actionModeSchema,
  textInsertSchema,
  clarifySchema
])

/** Root object (OpenAI strict mode needs an object root, not a union). */
export const replySchema = z.object({ response: modeReplySchema })

export type ModeReply = z.infer<typeof modeReplySchema>
export type Reply = z.infer<typeof replySchema>

export const PARSE_FAILED_TEXT = "Sorry, I couldn't process that."
const NOT_FOUND_TEXT = "I couldn't find that on screen."
const FOLLOW_UP_DELAY_MS = 2000
// Pointer-sized box drawn around a point target.
const POINT_BOX = 32

/** Tolerant parse for providers without structured output: wrapped, bare or prose replies. */
export function parseReplyText(text: string): ModeReply {
  const reply = parseJsonAs(text, replySchema)
  if (reply) return reply.response
  const bare = parseJsonAs(text, modeReplySchema)
  if (bare) return bare
  const prose = text.replace(/```\w*\n?/g, '').trim()
  if (prose && !prose.includes('{')) return { mode: 'answer', spoken: prose }
  return { mode: 'answer', spoken: PARSE_FAILED_TEXT }
}

/** Image-px rect a legacy bbox consumer can draw, for point and rect targets only. */
export function targetRect(t: Target | undefined): Rect | undefined {
  if (!t) return undefined
  if (t.kind === 'rect') return { x: t.x, y: t.y, w: t.w, h: t.h }
  if (t.kind === 'point')
    return { x: t.x - POINT_BOX / 2, y: t.y - POINT_BOX / 2, w: POINT_BOX, h: POINT_BOX }
  return undefined
}

function targetHint(t: Target | undefined, fallback: string): string {
  return t?.kind === 'text' ? t.text : fallback
}

// Matches follow-ups that are really questions to the user; those loop forever.
const QUESTION_FOLLOWUP_RE =
  /\b(would you like|do you want|shall i|should i|want me to|do you need|can i|may i)\b|\?$/i

function toAction(a: z.infer<typeof actionSchema>, inBrowser: boolean): Action {
  // One URL action for the model; reusing the current tab is an executor strategy.
  if (a.type === 'open_url' && inBrowser) return { type: 'navigate_url', url: a.url }
  return a as Action
}

/** Maps a schema reply to the ModelResponse shape the rest of the app consumes. */
export function toModelResponse(r: ModeReply, activeWindow = ''): ModelResponse {
  switch (r.mode) {
    case 'answer': {
      const text = r.markdown?.trim() || r.spoken
      return {
        mode: 'answer',
        text,
        spoken: r.spoken,
        ...(r.markdown ? { markdown: r.markdown } : {}),
        ...(r.point ? { point: r.point } : {})
      }
    }
    case 'clarify':
      return { mode: 'answer', text: r.question, spoken: r.question, clarify: true }
    case 'guide':
      return {
        mode: 'guide',
        steps: r.steps.map((s): GuideStep => {
          const bbox = targetRect(s.target)
          return {
            label: s.label,
            target_hint: targetHint(s.target, s.detail ?? s.label),
            ...(bbox ? { bbox } : {}),
            ...(s.target ? { target: s.target } : {}),
            ...(s.detail ? { detail: s.detail } : {})
          }
        })
      }
    case 'locate': {
      // Element, mark and text targets are resolved when presented (resolveTarget).
      const items: LocateItem[] = []
      for (const it of r.items) {
        const bbox = targetRect(it.target)
        if (bbox && (bbox.w <= 0 || bbox.h <= 0)) continue
        items.push({ label: it.label, ...(bbox ? { bbox } : {}), target: it.target })
      }
      if (!items.length) return { mode: 'answer', text: r.notFoundReason || NOT_FOUND_TEXT }
      return {
        mode: 'locate',
        items,
        ...(r.notFoundReason ? { notFoundReason: r.notFoundReason } : {})
      }
    }
    case 'action': {
      const inBrowser = isBrowser(activeWindow)
      const followUp = r.followUp?.trim()
      return {
        mode: 'action',
        actions: r.actions.map((a) => toAction(a, inBrowser)),
        summary: r.summary,
        risk: r.risk,
        ...(followUp && !QUESTION_FOLLOWUP_RE.test(followUp)
          ? { follow_up: { query: followUp, delay_ms: FOLLOW_UP_DELAY_MS } }
          : {})
      }
    }
    case 'text_insert':
      return {
        mode: 'text_insert',
        text: r.text,
        target_hint: targetHint(r.targetField, ''),
        ...(r.targetField ? { targetField: r.targetField } : {})
      }
  }
}
