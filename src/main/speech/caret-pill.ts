// The dictation pill next to the text caret (04 T47, `dictation.caretPill`): when a dictation
// starts, the agent's focus_info gives the system caret (or the focused field) and the bar
// moves there. No caret and no small field: the pill stays at the bottom centre.
import type { Rect } from '@shared/types'
import type { AgentBridge } from '../agent/bridge'
import { physRectToLogical } from '../actions/coords'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import * as assistant from '../windows/assistant'

/** A focused field taller than this is a document: its rect says nothing about the caret. */
const MAX_FIELD_HEIGHT = 160
const FOCUS_TIMEOUT_MS = 600

function rectOf(v: unknown): Rect | null {
  const r = v as Partial<Rect> | null | undefined
  if (!r || [r.x, r.y, r.w, r.h].some((n) => typeof n !== 'number' || !Number.isFinite(n)))
    return null
  return { x: r.x!, y: r.y!, w: r.w!, h: r.h! }
}

/** Physical rect the pill goes next to: the caret, else the left end of a one-line field. */
export function pillAnchor(info: { caret?: unknown; rect?: unknown } | null): Rect | null {
  const caret = rectOf(info?.caret)
  if (caret && caret.h > 0) return caret
  const field = rectOf(info?.rect)
  if (field && field.w > 0 && field.h > 0 && field.h <= MAX_FIELD_HEIGHT)
    return { x: field.x + 8, y: field.y, w: 0, h: field.h }
  return null
}

export function installCaretPill(agent: AgentBridge): void {
  let seq = 0
  bus.on('dictation.started', () => {
    const mine = ++seq
    if (!loadConfig().dictation.caretPill || !agent.running) return
    agent
      .request<Record<string, unknown>>('focus_info', {}, { timeoutMs: FOCUS_TIMEOUT_MS })
      .then((info) => {
        const anchor = pillAnchor(info)
        // A newer recording (or a cancel) owns the bar now.
        if (!anchor || mine !== seq) return
        const l = physRectToLogical(anchor)
        assistant.placeNear({ x: l.x, y: l.y, width: l.w, height: l.h })
      })
      .catch((e: Error) => log('skip', `caret pill: no caret (${e.message})`))
  })
  bus.on('voice.cancelled', () => seq++)
  // An assistant recording uses the bottom bar.
  bus.on('voice.started', () => {
    seq++
    assistant.placeNear(null)
  })
}
