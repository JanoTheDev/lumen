// Settings → the running OS agent (native sidecar), its version, or why it is not running.
import { ipcMain } from 'electron'
import type { AgentImplInfo } from '@shared/channels'
import type { AgentBridge } from '../agent/bridge'
import { getAgent } from '../agent/instance'

type BridgeView = Pick<AgentBridge, 'impl' | 'version' | 'running' | 'lastError'>

export function agentImplInfo(bridge: BridgeView | null): AgentImplInfo {
  if (!bridge) return { impl: null, version: null, protocol: null, error: null }
  const ready = bridge.running && bridge.impl !== null
  return {
    impl: ready ? 'native' : null,
    version: ready ? bridge.version : null,
    protocol: ready ? 2 : null,
    error: bridge.lastError
  }
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:info', (_e, ...args: unknown[]) => {
    if (args.length) return { error: 'E_INVALID' }
    return agentImplInfo(getAgent())
  })
}
