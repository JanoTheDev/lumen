// Parsing and cleanup of the model's JSON reply.
import type { Action, ModelResponse as ClaudeResponse, Rect } from '@shared/types'
import { normalizeBbox, isUsableRect } from '../actions/coords'

// Returns the first balanced {...} object in s (skipping any leading prose), or null.
// Braces inside JSON strings are ignored.
export function extractFirstJson(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

const PARSE_FAILED_TEXT = "Sorry, I couldn't process that."

// Converts every bbox the model returned to a Rect; legacy [x1,y1,x2,y2] arrays still work.
function normalizeBboxes(parsed: Record<string, unknown>): void {
  const fix = (o: Record<string, unknown>): void => {
    if (!o || typeof o !== 'object' || !('bbox' in o)) return
    const rect = normalizeBbox(o.bbox)
    if (Array.isArray(o.bbox) && rect) console.warn('[warn] legacy bbox', JSON.stringify(o.bbox))
    if (rect) o.bbox = rect
    else delete o.bbox
  }
  for (const key of ['steps', 'actions', 'items']) {
    const list = parsed[key]
    if (Array.isArray(list)) list.forEach((o) => fix(o as Record<string, unknown>))
  }
}

// Unparseable output: keep plain prose answers, hide anything containing broken JSON.
function parseFallback(cleaned: string): ClaudeResponse {
  if (cleaned && !cleaned.includes('{')) return { mode: 'answer', text: cleaned }
  return { mode: 'answer', text: PARSE_FAILED_TEXT }
}

export function parseResponse(raw: string): ClaudeResponse {
  const cleaned = raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
  try {
    // Extract first complete JSON object BEFORE parsing: drops leading prose and handles
    // the model returning double JSON ("{...}{...}" would make JSON.parse throw)
    const target = extractFirstJson(cleaned)
    if (target === null) return parseFallback(cleaned)
    const parsed = JSON.parse(target) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return parseFallback(cleaned)

    // Model sometimes wraps real JSON inside {"mode":"answer","text":"{...}"}
    if (parsed.mode === 'answer' && typeof parsed.text === 'string') {
      const inner = (parsed.text as string).trim()
      if (inner.startsWith('{')) {
        const unwrapped = parseResponse(inner)
        if (unwrapped.mode !== 'answer') return unwrapped
      }
    }

    if (
      parsed.mode !== 'answer' &&
      parsed.mode !== 'guide' &&
      parsed.mode !== 'action' &&
      parsed.mode !== 'text_insert' &&
      parsed.mode !== 'locate'
    ) {
      if (parsed.text || parsed.button) {
        return { mode: 'action', actions: [parsed as unknown as Action], summary: '' }
      }
      return { mode: 'answer', text: PARSE_FAILED_TEXT }
    }

    normalizeBboxes(parsed)

    // Locate items without a usable bbox cannot be highlighted
    if (parsed.mode === 'locate') {
      const items = Array.isArray(parsed.items)
        ? (parsed.items as Array<Record<string, unknown>>)
        : []
      parsed.items = items.filter(
        (it) => it && typeof it === 'object' && isUsableRect(it.bbox as Rect | undefined)
      )
      if ((parsed.items as unknown[]).length === 0) {
        return { mode: 'answer', text: "I couldn't find that on screen." }
      }
    }

    // Normalize mode=action where AI put open_url at top level
    if (
      parsed.mode === 'action' &&
      (!parsed.actions || (parsed.actions as unknown[]).length === 0)
    ) {
      const url = (parsed.open_url || parsed.url) as string | undefined
      if (url) {
        return {
          mode: 'action',
          actions: [{ type: 'open_url', url }],
          summary: parsed.summary as string | undefined,
          follow_up: parsed.follow_up as { query: string; delay_ms: number } | undefined
        }
      }
    }

    // Normalize action objects where AI used "mode" instead of "type"
    if (parsed.mode === 'action' && Array.isArray(parsed.actions)) {
      parsed.actions = (parsed.actions as Record<string, unknown>[]).map((a) => {
        if (!a.type && a.mode) {
          const { mode: actionMode, ...rest } = a
          return { type: actionMode, ...rest }
        }
        return a
      })
    }

    return parsed as unknown as ClaudeResponse
  } catch {
    return parseFallback(cleaned)
  }
}

// Matches follow_up queries that are actually clarification questions — these loop forever.
const QUESTION_FOLLOWUP_RE =
  /\b(would you like|do you want|shall i|should i|want me to|do you need|can i|may i)\b|\?$/i

export function sanitizeResponse(r: ClaudeResponse): ClaudeResponse {
  if (r.mode === 'action' && r.follow_up && QUESTION_FOLLOWUP_RE.test(r.follow_up.query)) {
    delete r.follow_up
  }
  return r
}
