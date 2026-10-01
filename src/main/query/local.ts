// Router stages 1 + 2 wired to the app: 06's grammar, then prefilter hits for guides and
// cancel words. Returns the renderer response when handled, else undefined.
import { routeLocal } from './router'
import { cancelAll } from './cancel'
import { hasLastTask } from './pipeline'
import { bus } from '../bus'
import { dismissGuide, guideState, handleGuideCommand } from '../guides/session'
import { log } from '../logger'
import { setStatus } from '../windows/status'

export function interceptLocal(prompt: string): unknown | undefined {
  return routeLocal(prompt, { ...guideState(), hasLastTask: hasLastTask() }, (hit) => {
    if (hit.kind !== 'cancel') return handleGuideCommand(hit)
    if (cancelAll()) log('skip', 'cancel word: aborting in-flight work')
    else {
      // Nothing running: close whatever is on screen, like the voice cancel phrase.
      bus.emit({ type: 'voice.cancelled' })
      dismissGuide()
    }
    setStatus('error', 'Cancelled', undefined, 1200)
    return { mode: 'answer', text: 'Cancelled.', cancelled: true }
  })
}
