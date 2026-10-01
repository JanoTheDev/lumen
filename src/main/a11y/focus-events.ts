// focus-changed is a subscribed agent event; several features (narration, dwell snap, lessons)
// may want it at once. The agent gets it while at least one owner does.
import { refCountedSubscription } from '../agent/subscriptions'

const focus = refCountedSubscription('focus-changed')

/** True while some feature wants focus-changed (also sent in the agent's `init`). */
export function focusEventsWanted(): boolean {
  return focus.wanted()
}

/** Re-sends the current focus-changed subscription to the agent. */
export function pushFocusSubscription(): void {
  focus.push()
}

/** Asks for (or releases) the agent's focus-changed events on behalf of `owner`. */
export function wantFocusEvents(owner: string, on: boolean): void {
  focus.want(owner, on)
}
