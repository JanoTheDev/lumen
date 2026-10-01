// Pure helpers for the assistant bar: labels, streaming chunks, meter smoothing, error hints.
import type { AssistantView } from '@shared/channels'
import type { AgentTask, AssistantPhase } from '@shared/events'

export const PHASE_LABEL: Record<AssistantPhase, string> = {
  idle: 'Ready',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
  acting: 'Acting',
  'waiting-user': 'Your turn',
  confirm: 'Needs OK',
  error: 'Something went wrong'
}

/** The bar row text: main's status line when it has one, else the phase name. */
export function statusLine(v: Pick<AssistantView, 'phase' | 'statusText' | 'answer'>): string {
  if (v.statusText) return v.statusText.replace(/…$/, '')
  if (v.phase === 'idle' && v.answer) return v.answer.streaming ? 'Answering' : 'Answer'
  return PHASE_LABEL[v.phase]
}

export interface Chunk {
  id: number
  text: string
}

/**
 * Streaming text as appended chunks, so only the new words fade in. A text that does not
 * extend the previous one (a new turn, or the final rewrite) starts over.
 */
export function appendChunks(prev: Chunk[], text: string): Chunk[] {
  const joined = prev.map((c) => c.text).join('')
  if (!text.startsWith(joined) || (!text && prev.length)) return text ? [{ id: 0, text }] : []
  const extra = text.slice(joined.length)
  if (!extra) return prev
  const id = prev.length ? prev[prev.length - 1].id + 1 : 0
  return [...prev, { id, text: extra }]
}

/** One-pole smoothing with separate attack and release times (ms), frame time `dtMs`. */
export function smoothLevel(
  prev: number,
  target: number,
  dtMs: number,
  attackMs = 30,
  releaseMs = 120
): number {
  const tau = target > prev ? attackMs : releaseMs
  const a = 1 - Math.exp(-dtMs / Math.max(1, tau))
  return prev + (target - prev) * a
}

/** A next step for errors main reports without one. */
export function errorHint(message: string): string | undefined {
  const m = message.toLowerCase()
  if (/api key|no key|401|unauthori[sz]ed|invalid x-api-key/.test(m))
    return 'Check your key in Settings → Models & keys.'
  if (/microphone|notallowederror|permission denied|notfounderror/.test(m))
    return 'Microphone is blocked. Open Windows Settings → Privacy → Microphone.'
  if (/network|fetch failed|enotfound|econnrefused|timed? ?out|etimedout/.test(m))
    return 'Check your internet connection, then try again.'
  if (/rate limit|429|overloaded|529/.test(m)) return 'The service is busy. Try again in a moment.'
  if (/agent/.test(m)) return 'The helper process is restarting. Try again in a few seconds.'
  return undefined
}

/** Label of the agent step list: "2 of 5 steps done". */
export function progressLabel(task: Pick<AgentTask, 'steps'>): string {
  const done = task.steps.filter((s) => s.status === 'done').length
  return `${done} of ${task.steps.length} steps done`
}
