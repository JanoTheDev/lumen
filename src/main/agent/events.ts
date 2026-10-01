// Agent events (hotkey, wake word, voice cancel, dwell, mouse) and agent lifecycle status.
import type { AgentBridge } from './bridge'
import { holdEscape } from './escape'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import { physToLogical } from '../actions/coords'
import { dismissGuide } from '../guides/session'
import { cancelAll } from '../query/cancel'
import * as dwellRing from '../windows/dwell-ring'
import { isOverOwnWindow } from '../windows/registry'
import { setStatus } from '../windows/status'
import { onDictationDown, onDictationUp } from '../speech/dictation/pipeline'
import { onAssistantHotkeyDown, onAssistantHotkeyUp } from '../speech/hotkey'

let agentFailed = false

/** Starts the agent without blocking IPC registration; failures show in the status bubble. */
export function startAgent(agent: AgentBridge): void {
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
  agent.onEvent('agent-ready', () => {
    if (agentFailed) setStatus('answer', 'Agent back online', undefined, 1500)
    agentFailed = false
  })

  agent.onEvent('hotkey-down', () => onAssistantHotkeyDown())
  agent.onEvent('hotkey-up', () => onAssistantHotkeyUp())

  agent.onEvent('dictation-down', () => onDictationDown())
  agent.onEvent('dictation-up', () => onDictationUp())

  agent.onEvent('wake-detected', () => {
    console.log('[wake] detected — showing HUD, starting recording with VAD auto-stop')
    holdEscape('hud')
    bus.emit({ type: 'voice.started', handsFree: true })
    setStatus('listening', 'Wake word detected — listening…')
  })

  agent.onEvent('voice-cancel', (data) => {
    const phrase = (data?.phrase as string | undefined) ?? 'cancel'
    console.log(`[cancel-voice] matched "${phrase}"`)
    if (cancelAll()) {
      setStatus('error', 'Cancelled by voice', undefined, 1600)
    } else {
      // Not in a query — treat as "close any active UI"
      bus.emit({ type: 'voice.cancelled' })
      dismissGuide()
    }
  })

  agent.onEvent('dwell-progress', (data) => {
    if (!loadConfig().dwellClick.enabled) return
    dwellRing.progress(data)
  })

  agent.onEvent('dwell-trigger', (data) => {
    if (!loadConfig().dwellClick.enabled) return
    const x = data?.x as number | undefined
    const y = data?.y as number | undefined
    if (typeof x !== 'number' || typeof y !== 'number') return
    // Suppress dwell-click over the HUD / answer / status / settings windows
    if (isOverOwnWindow(physToLogical({ x, y }))) return
    console.log(`[dwell] click at (${x}, ${y})`)
    setStatus('acting', 'Dwell click', undefined, 900)
    agent
      .execute({ type: 'click', x, y, button: 'left' })
      .catch((e) => console.error('[dwell] click failed:', (e as Error).message))
  })

  agent.onEvent('mouse-moved', () => {
    if (!loadConfig().guideAutoDismissOnMove) return
    dismissGuide()
  })
}
