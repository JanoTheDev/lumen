// The process-wide agent bridge, created once in index.ts.
import type { AgentBridge } from './bridge'

/** Said when a turn needs the native agent and it is not there (spoken on the bar). */
export const AGENT_DOWN_TEXT =
  "My screen helper isn't running. Restart Lumen, or check Settings, Diagnostics."

let agent: AgentBridge | null = null

export function setAgent(next: AgentBridge | null): void {
  agent = next
}

export function getAgent(): AgentBridge | null {
  return agent
}

export function requireAgent(): AgentBridge {
  if (!agent) {
    // Shaped like the bridge's AgentError without loading the bridge here.
    const e = new Error(AGENT_DOWN_TEXT) as Error & { code: string }
    e.name = 'AgentError'
    e.code = 'E_AGENT_NOT_RUNNING'
    throw e
  }
  return agent
}
