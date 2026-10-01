// Subscribable agent events several features may want at once. The agent gets an event while
// at least one owner wants it; `init` carries the current set after every (re)start.
import { getAgent } from './instance'
import { log } from '../logger'

export interface Subscription {
  /** True while some owner wants the event. */
  wanted(): boolean
  /** Re-sends the current state to the agent. */
  push(): void
  /** Asks for (or releases) the event on behalf of `owner`. */
  want(owner: string, on: boolean): void
}

/** `capability`: only ask an agent that reports it (others reject unknown events). */
export function refCountedSubscription(event: string, capability?: string): Subscription {
  const owners = new Set<string>()
  const wanted = (): boolean => owners.size > 0
  const push = (): void => {
    const agent = getAgent()
    if (!agent?.running) return
    if (capability && !agent.hasCapability(capability)) return
    agent
      .request('subscribe', { events: [event], enabled: wanted() })
      .catch((e: Error) => log('skip', `${event} subscribe failed (${e.message})`))
  }
  return {
    wanted,
    push,
    want(owner, on) {
      const before = wanted()
      if (on) owners.add(owner)
      else owners.delete(owner)
      if (before !== wanted()) push()
    }
  }
}

/** mouse-moved: guide auto-dismiss and the follow buddy. */
export const mouseEvents = refCountedSubscription('mouse-moved')

/** uia-event (invoked / value / selected / window-opened): lesson checks. */
export const uiaEvents = refCountedSubscription('uia-event', 'uia-events')

/** key-combo (observe-only shortcuts, never typing): lesson keypress checks. */
export const keyComboEvents = refCountedSubscription('key-combo', 'key-combo')

/** user-activity (throttled pings for physical keyboard / mouse input): input lane pause. */
export const userActivityEvents = refCountedSubscription('user-activity', 'user-activity')

/** True once the cursor has moved more than `px` from where the last `true` (or the start) was. */
export function moveGate(px: number): (p: { x: number; y: number }) => boolean {
  let anchor: { x: number; y: number } | null = null
  return (p) => {
    if (!anchor) {
      anchor = p
      return false
    }
    if (Math.hypot(p.x - anchor.x, p.y - anchor.y) <= px) return false
    anchor = p
    return true
  }
}
