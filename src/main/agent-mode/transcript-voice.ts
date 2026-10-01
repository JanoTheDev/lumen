// Task chat by voice (08 T41): "show me what the email task is doing" opens the chat view,
// "tell the background task to also check Outlook" sends it a steer message. Pure matching;
// transcript-wire.ts acts on it.
import type { ChatSummary } from '@shared/task-chat'

export type ChatIntent =
  | { kind: 'show'; name: string }
  | { kind: 'steer'; name: string; text: string }

const TASK = String.raw`(?:background\s+)?(?:task|agent|job)`

const SHOW_RE = new RegExp(
  String.raw`^(?:show(?:\s+me)?|open|let\s+me\s+see|pull\s+up)\s+(?:what\s+)?(?:the\s+|my\s+)?(.*?)\s*${TASK}(?:'s)?(?:\s+(?:is\s+doing|is\s+up\s+to|chat|transcript|conversation))?$`,
  'i'
)
const WHAT_RE = new RegExp(
  String.raw`^what(?:'s|\s+is)\s+(?:the\s+|my\s+)?(.*?)\s*${TASK}\s+(?:doing|up\s+to)$`,
  'i'
)
const STEER_RE = new RegExp(
  String.raw`^(?:tell|ask)\s+(?:the\s+|my\s+)?(.*?)\s*${TASK}\s+(?:to\s+|that\s+)?(.+)$`,
  'i'
)

const FILLER = /\b(running|current|that|this|the|my|one|background|open)\b/gi

function cleanName(s: string): string {
  return s.replace(FILLER, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function matchTaskChatIntent(utterance: string): ChatIntent | null {
  const u = utterance
    .trim()
    .replace(/^(?:ok(?:ay)?|please|hey lumen|lumen)[,\s]+/i, '')
    .replace(/\s+please$/i, '')
    .replace(/[.!?]+$/, '')
    .trim()
  const steer = STEER_RE.exec(u)
  if (steer && steer[2].trim().split(/\s+/).length >= 2)
    return { kind: 'steer', name: cleanName(steer[1]), text: steer[2].trim() }
  const show = SHOW_RE.exec(u) ?? WHAT_RE.exec(u)
  if (show) return { kind: 'show', name: cleanName(show[1]) }
  return null
}

const OPEN = new Set(['queued', 'running', 'paused', 'asking', 'confirm'])

/** The chat a spoken name means: the best title match (open ones win a tie), else the newest open one. */
export function pickChat(name: string, rows: readonly ChatSummary[]): ChatSummary | null {
  if (!rows.length) return null
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
  if (!words.length) return rows.find((r) => OPEN.has(r.phase)) ?? rows[0]
  let best: ChatSummary | null = null
  let bestScore = 0
  for (const r of rows) {
    const title = r.title.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    let score = 0
    for (const w of words)
      if (title.some((t) => t === w || (t.length >= 4 && (t.startsWith(w) || w.startsWith(t)))))
        score += 2
    if (r.kind === 'claude' && words.includes('claude')) score += 1
    if (score && OPEN.has(r.phase)) score += 1
    if (score > bestScore) {
      best = r
      bestScore = score
    }
  }
  return best
}
