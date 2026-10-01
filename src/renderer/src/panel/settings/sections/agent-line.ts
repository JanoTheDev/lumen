import type { AgentImplInfo } from '@shared/channels'

/** "OS agent: Native 0.1.0", "OS agent: not running (…)", or "starting". */
export function agentLine(info: AgentImplInfo | null): string {
  if (info?.error) return `OS agent: not running (${info.error})`
  if (!info || !info.impl) return 'OS agent: starting'
  const version = info.version ? ` ${info.version}` : ''
  return `OS agent: Native${version}`
}
