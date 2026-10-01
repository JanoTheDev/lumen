// Settings → which OS agent runs (native sidecar or Python fallback) and its version.
import { ipcMain } from 'electron'
import type { AgentImplInfo } from '@shared/channels'
import type { AgentBridge } from '../agent/bridge'
import { getAgent } from '../agent/instance'

type BridgeView = Pick<AgentBridge, 'impl' | 'version' | 'protocol' | 'running' | 'implFallback'>

export function agentImplInfo(bridge: BridgeView | null): AgentImplInfo {
  if (!bridge) return { impl: null, version: null, protocol: null, fallback: null }
  const impl = bridge.impl === 'native' || bridge.impl === 'python' ? bridge.impl : null
  return {
    // Only the Python agent speaks protocol v1, and it sends no ready info there.
    impl: impl ?? (bridge.running && bridge.protocol === 1 ? 'python' : null),
    version: bridge.version,
    protocol: bridge.running ? bridge.protocol : null,
    fallback: bridge.implFallback
  }
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:info', (_e, ...args: unknown[]) => {
    if (args.length) return { error: 'E_INVALID' }
    return agentImplInfo(getAgent())
  })
}
