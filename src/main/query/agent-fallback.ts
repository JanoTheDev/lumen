// Multi-step and research requests run as agent-mode tasks, which need tool use. A local
// model server has none: those turns fall back to one plain model call, with a short note.
import type { ModelResponse } from '@shared/types'
import { getProvider } from '../ai/providers'

export const NO_AGENT_NOTE =
  "Your local model can't run multi-step tasks, so I did this in one step."

/** Whether the main model can drive an agent-mode task (tool use). */
export function agentModeAvailable(): boolean {
  try {
    return !!getProvider('main').llm.toolTurn
  } catch {
    // No key and no local server: the agent task reports that itself, as before.
    return true
  }
}

/** Puts the note in front of what the reply shows and speaks. */
export function withNoAgentNote(r: ModelResponse): ModelResponse {
  if (r.mode === 'answer')
    return {
      ...r,
      text: `${NO_AGENT_NOTE}\n\n${r.text}`,
      ...(r.spoken ? { spoken: `${NO_AGENT_NOTE} ${r.spoken}` } : {})
    }
  if (r.mode === 'action')
    return { ...r, summary: r.summary ? `${NO_AGENT_NOTE} ${r.summary}` : NO_AGENT_NOTE }
  return r
}
