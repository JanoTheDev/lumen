import { checkAction, needsWindowContext } from './safety'
import type { AgentAction } from './agent-action'
import { getAgent } from '../agent/instance'
import { log } from '../logger'
import { setStatus } from '../windows/status'

// Runs the central safety policy on one action. Actions that need confirmation are
// blocked for now (there is no confirm flow yet) and the user is told why.
export async function passesPolicy(action: AgentAction, prev?: AgentAction): Promise<boolean> {
  let windowTitle: string | undefined
  if (needsWindowContext(action)) {
    try {
      windowTitle = await getAgent()?.activeWindow()
    } catch {
      /* unknown window, policy treats it as non-shell */
    }
  }
  const { verdict, reason } = checkAction(action, { windowTitle, afterType: prev?.type === 'type' })
  if (verdict === 'allow') return true
  log('fail', `blocked by policy (${verdict}): ${reason ?? action.type}`)
  setStatus('error', `Blocked for safety: ${reason ?? action.type}`, undefined, 3000)
  return false
}
