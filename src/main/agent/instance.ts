// The process-wide agent bridge, created once in index.ts.
import type { AgentBridge } from './bridge'

let agent: AgentBridge | null = null

export function setAgent(next: AgentBridge | null): void {
  agent = next
}

export function getAgent(): AgentBridge | null {
  return agent
}

export function requireAgent(): AgentBridge {
  if (!agent) throw new Error('Agent not ready')
  return agent
}
