// Usage scope: who caused a model / search / speech call. Set where work starts (a pipeline turn,
// an agent or background task, an automation or buddy run, a sub-agent job, dictation, a lesson)
// and read where the call is recorded. Nested scopes keep their parents' fields.
import { AsyncLocalStorage } from 'async_hooks'

export type UsageOrigin =
  | 'user-direct'
  | 'agent'
  | 'background'
  | 'automation'
  | 'buddy'
  | 'subagent'
  | 'lesson'
  | 'routine'
  | 'claude-code-copilot'
  | 'dictation'
  | 'system'

export interface UsageScope {
  origin: UsageOrigin
  /** What the call was for: answer, describe, router, agent-step, research, how-to, stt, tts … */
  feature?: string
  taskId?: string
  parentTaskId?: string
  automationId?: string
  buddyId?: string
  skillId?: string
  ccSession?: string
}

const storage = new AsyncLocalStorage<UsageScope>()

/** The scope of the running work; `system` when nothing set one. */
export function currentUsageScope(): UsageScope {
  return storage.getStore() ?? { origin: 'system' }
}

/**
 * Runs `fn` inside a scope made of the current one plus `patch`. Fields the patch leaves out are
 * kept, so a sub-agent job inside a buddy's task still carries the buddy id. A new taskId moves
 * the old one to parentTaskId unless the patch sets that too.
 */
export function withUsageScope<T>(patch: Partial<UsageScope>, fn: () => T): T {
  const parent = storage.getStore()
  const next: UsageScope = { ...(parent ?? { origin: 'system' }), ...patch }
  if (
    patch.taskId &&
    parent?.taskId &&
    patch.taskId !== parent.taskId &&
    patch.parentTaskId === undefined
  )
    next.parentTaskId = parent.taskId
  return storage.run(next, fn)
}

/** Sets only the feature for one call: `withUsageFeature('summarize', () => callModel(…))`. */
export function withUsageFeature<T>(feature: string, fn: () => T): T {
  return withUsageScope({ feature }, fn)
}
