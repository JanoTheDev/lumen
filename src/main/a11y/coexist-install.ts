// T20 wiring: when Voice Access / Dragon start or stop, re-apply the wake word (off while Dragon
// runs) and tell the user once how to address Lumen. The agent reports the state (a11y-state
// events on change, a11y_state once at start).
import { applyListenerState } from '../agent/sync'
import { loadConfig } from '../config'
import { log } from '../logger'
import { onAtStateChange } from './at-state'
import { coexistNotice, wakeSuspended } from './coexist'

export function installCoexist(deps: { announce: (text: string) => void }): () => void {
  return onAtStateChange((next, prev) => {
    const cfg = loadConfig()
    if (wakeSuspended(next, cfg) !== wakeSuspended(prev, cfg)) applyListenerState(cfg)
    const notice = coexistNotice(prev, next, cfg)
    if (next.voiceControl.join() !== prev.voiceControl.join())
      log('step', `voice control running: ${next.voiceControl.join(', ') || 'none'}`)
    if (notice) deps.announce(notice)
  })
}
