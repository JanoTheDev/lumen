// Agent events (hotkey, dictation, dwell, mouse) and agent lifecycle status.
import type { AgentBridge } from './bridge'
import { mouseEvents, moveGate } from './subscriptions'
import { loadConfig } from '../config'
import { log } from '../logger'
import { dwellController } from '../a11y/dwell'
import { dismissGuide } from '../guides/session'
import { physToLogical } from '../actions/coords'
import * as screenLayer from '../windows/screen-layer'
import { onConfigPatched } from '../ipc/settings'
import { setStatus } from '../windows/status'
import { onDictationDown, onDictationUp } from '../speech/dictation/pipeline'
import { onAssistantHotkeyDown, onAssistantHotkeyUp } from '../speech/hotkey'

/** Physical px the cursor must travel before a guide is dismissed on move. */
const GUIDE_DISMISS_PX = 12

let agentFailed = false

/** Starts the agent without blocking IPC registration; failures show in the status bubble. */
export function startAgent(agent: AgentBridge): void {
  agent.start().catch((e) => {
    agentFailed = true
    log('fail', `agent failed to start: ${(e as Error).message}`)
    setStatus('error', 'Lumen helper failed to start — see logs', undefined, 8000)
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

  // Dwell v2 (a11y/dwell.ts) decides what a dwell does, also on Lumen's own windows.
  agent.onEvent('dwell-progress', (data) => dwellController()?.onProgress(data))
  agent.onEvent('dwell-trigger', (data) => {
    dwellController()
      ?.onTrigger(data)
      .catch((e) => console.error('[dwell] click failed:', (e as Error).message))
  })

  // mouse-moved {x, y} physical px, ~60 Hz while moving: follow buddy + guide auto-dismiss.
  const guideMove = moveGate(GUIDE_DISMISS_PX)
  agent.onEvent('mouse-moved', (data) => {
    const p = data as { x?: unknown; y?: unknown } | undefined
    if (typeof p?.x !== 'number' || typeof p.y !== 'number') return
    const phys = { x: p.x, y: p.y }
    screenLayer.onCursorMoved(physToLogical(phys))
    if (guideMove(phys) && loadConfig().guideAutoDismissOnMove) dismissGuide()
  })
  mouseEvents.want('guide-dismiss', loadConfig().guideAutoDismissOnMove)
  onConfigPatched((next) => mouseEvents.want('guide-dismiss', next.guideAutoDismissOnMove))
}
