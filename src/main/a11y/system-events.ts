// Agent events that replace main-side polling: `system-settings` (Windows text size; high
// contrast and reduced motion reach the renderers through Chromium already) and `a11y-state`
// (screen reader / voice control, sent on change). Both arrive once after every subscribe.
import type { AgentBridge } from '../agent/bridge'
import { setAtState } from './at-state'
import { setTextScale } from './text-scale'

export const SYSTEM_EVENTS = ['system-settings', 'a11y-state'] as const

/** `onAtChange` runs when the assistive-tech state actually changed. */
export function installSystemEvents(agent: AgentBridge, onAtChange: () => void): void {
  agent.onEvent('system-settings', (data) => {
    setTextScale((data as { textScale?: unknown } | undefined)?.textScale)
  })
  agent.onEvent('a11y-state', (data) => {
    if (setAtState(data)) onAtChange()
  })
}

/** Asks the agent once (agent-ready); events keep it current afterwards. */
export async function refreshAtState(agent: AgentBridge | null): Promise<boolean> {
  if (!agent?.running) return false
  try {
    return setAtState(await agent.request('a11y_state', {}, { timeoutMs: 2000 }))
  } catch {
    return false /* keep the last state */
  }
}
