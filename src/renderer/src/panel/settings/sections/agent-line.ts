import type { AgentImplInfo } from '@shared/channels'

/** "OS agent: Native 0.1.0", "OS agent: Python (fallback: …)", or "starting". */
export function agentLine(info: AgentImplInfo | null): string {
  if (!info || !info.impl) return 'OS agent: starting'
  const name = info.impl === 'native' ? 'Native' : 'Python'
  const version = info.version ? ` ${info.version}` : ''
  const fallback = info.fallback ? ` (fallback: ${info.fallback})` : ''
  return `OS agent: ${name}${version}${fallback}`
}
