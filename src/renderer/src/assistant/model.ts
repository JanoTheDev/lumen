// Pure helpers for the assistant bar: labels, streaming reveal, simple mode, meter smoothing,
// error hints.
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

/**
 * What the streaming answer shows: the text up to the last whole word, so words appear one
 * at a time instead of growing letter by letter. The final text is shown as is.
 */
export function revealText(text: string, streaming: boolean): string {
  if (!streaming || /\s$/.test(text)) return text
  return text.replace(/\S+$/, '')
}

/** The rows the bar can show; simple mode shows one of them at a time. */
export type BarRow = 'confirm' | 'answer' | 'task' | 'step' | 'notice' | 'live' | 'caption'

/** Simple mode (06 T18): the one row that matters most right now, or null for the bar only. */
export function simpleRow(
  v: Pick<
    AssistantView,
    'confirm' | 'answer' | 'error' | 'agentTask' | 'step' | 'notice' | 'live' | 'caption'
  > & { captionEdit?: unknown }
): BarRow | null {
  if (v.confirm) return 'confirm'
  if (v.captionEdit) return 'caption'
  if (v.answer || v.error) return 'answer'
  if (v.agentTask) return 'task'
  if (v.step) return 'step'
  if (v.notice) return 'notice'
  if (v.live && !v.live.echo) return 'live'
  if (v.caption) return 'caption'
  return null
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

/** The step simple mode shows: the running one, else the first failed or still to do. */
export function currentStep(
  task: Pick<AgentTask, 'steps'>
): AgentTask['steps'][number] | undefined {
  return (
    task.steps.find((s) => s.status === 'running') ??
    task.steps.find((s) => s.status === 'failed') ??
    task.steps.find((s) => s.status === 'pending')
  )
}
