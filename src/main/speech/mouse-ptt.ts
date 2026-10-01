// Dictation push-to-talk on a mouse button (04 T48, `dictation.mouseButton`). The agent's
// low-level mouse hook swallows that button and reports it as dictation-down / dictation-up,
// so it acts exactly like the dictation hotkey (hold, double-tap hands-free). The hook is only
// installed while a button is chosen; left and right are never offered.
import type { AppConfig } from '../config'
import type { AgentBridge } from '../agent/bridge'
import { pttMouse } from '../agent/commands'
import { loadConfig } from '../config'
import { log } from '../logger'
import { onConfigPatched } from '../ipc/settings'

export type PttButton = '' | 'middle' | 'x1' | 'x2'

/** The button the hook should hold, "" for none. Pure. */
export function wantedPttButton(cfg: Pick<AppConfig, 'dictation'>): PttButton {
  const d = cfg.dictation
  return d.enabled && d.mouseButton !== 'off' ? d.mouseButton : ''
}

export function installMousePtt(agent: AgentBridge): void {
  let applied: PttButton | null = null
  const apply = (force = false): void => {
    const want = wantedPttButton(loadConfig())
    if (!force && want === applied) return
    if (!agent.running) return
    if (!agent.hasCapability('ptt-mouse')) {
      if (want) log('skip', 'mouse push-to-talk: the helper does not support it yet')
      return
    }
    applied = want
    pttMouse(agent, want).then(
      () => {
        if (want) log('step', `mouse push-to-talk on ${want}`)
      },
      (e: Error) => {
        applied = null
        log('fail', `mouse push-to-talk failed: ${e.message}`)
      }
    )
  }
  // A restarted agent has no hook state.
  agent.onEvent('agent-ready', () => {
    applied = null
    apply(true)
  })
  onConfigPatched(() => apply())
  apply()
}
