// focus-changed is a subscribed agent event; several features (narration, dwell snap, lessons)
// may want it at once. The agent gets it while at least one owner does.
import { getAgent } from '../agent/instance'
import { log } from '../logger'

const focusOwners = new Set<string>()

/** True while some feature wants focus-changed (also sent in the agent's `init`). */
export function focusEventsWanted(): boolean {
  return focusOwners.size > 0
}

/** Re-sends the current focus-changed subscription to the agent. */
export function pushFocusSubscription(): void {
  const agent = getAgent()
  if (!agent?.running) return
  agent
    .request('subscribe', { events: ['focus-changed'], enabled: focusEventsWanted() })
    .catch((e: Error) => log('skip', `focus-changed subscribe failed (${e.message})`))
}

/** Asks for (or releases) the agent's focus-changed events on behalf of `owner`. */
export function wantFocusEvents(owner: string, on: boolean): void {
  const before = focusEventsWanted()
  if (on) focusOwners.add(owner)
  else focusOwners.delete(owner)
  if (before !== focusEventsWanted()) pushFocusSubscription()
}
