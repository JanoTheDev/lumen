// Agent events (hotkey, wake word, voice cancel, dwell, mouse) and agent lifecycle status.
import type { AgentBridge } from './bridge'
import { loadConfig } from '../config'
import { log } from '../logger'
import { dwellController } from '../a11y/dwell'
import { dismissGuide } from '../guides/session'
import { setStatus } from '../windows/status'
import { onDictationDown, onDictationUp } from '../speech/dictation/pipeline'
import { onAssistantHotkeyDown, onAssistantHotkeyUp } from '../speech/hotkey'
import { handleVoiceCancel, handleWake } from '../speech/wake/handlers'

let agentFailed = false

/** Starts the agent without blocking IPC registration; failures show in the status bubble. */
export function startAgent(agent: AgentBridge): void {
  agent.setImpl(() => loadConfig().agentImpl)
  agent.start().catch((e) => {
    agentFailed = true
    log('fail', `agent failed to start: ${(e as Error).message}`)
    setStatus('error', 'Agent failed to start — see logs', undefined, 8000)
  })
}

export function wireAgentEvents(agent: AgentBridge): void {
  agent.onEvent('agent-down', (data) => {
    if (data?.gaveUp) setStatus('error', 'Agent stopped responding — see logs', undefined, 8000)
    else setStatus('error', 'Agent restarting…', undefined, 3000)
  })
  agent.onEvent('agent-impl-fallback', (data) => {
    log('skip', `native agent dropped for this session: ${String(data?.reason ?? 'unknown')}`)
  })
  agent.onEvent('agent-ready', () => {
    if (agentFailed) setStatus('answer', 'Agent back online', undefined, 1500)
    agentFailed = false
  })

  agent.onEvent('hotkey-down', () => onAssistantHotkeyDown())
  agent.onEvent('hotkey-up', () => onAssistantHotkeyUp())

  agent.onEvent('dictation-down', () => onDictationDown())
  agent.onEvent('dictation-up', () => onDictationUp())

  agent.onEvent('wake-detected', () => handleWake('vosk'))
  agent.onEvent('voice-cancel', (data) =>
    handleVoiceCancel((data?.phrase as string | undefined) ?? 'cancel')
  )

  // Dwell v2 (a11y/dwell.ts) decides what a dwell does, also on Lumen's own windows.
  agent.onEvent('dwell-progress', (data) => dwellController()?.onProgress(data))
  agent.onEvent('dwell-trigger', (data) => {
    dwellController()
      ?.onTrigger(data)
      .catch((e) => console.error('[dwell] click failed:', (e as Error).message))
  })

  agent.onEvent('mouse-moved', () => {
    if (!loadConfig().guideAutoDismissOnMove) return
    dismissGuide()
  })
}
