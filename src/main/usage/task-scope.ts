// The usage scope of a background task (05 T43): automations, buddies, skills and spawned
// helpers each get their own ids on every ledger line the run makes.
import type { BackgroundTask } from '@shared/types'
import type { UsageScope } from './scope'

export function usageScopeForTask(
  task: Pick<BackgroundTask, 'id' | 'origin' | 'skill' | 'parentId' | 'routineId' | 'buddyId'>
): Partial<UsageScope> {
  const scope: Partial<UsageScope> = {
    origin:
      task.origin === 'routine' ? 'automation' : task.origin === 'buddy' ? 'buddy' : 'background',
    feature: 'agent-step',
    taskId: task.id
  }
  if (task.parentId) scope.parentTaskId = task.parentId
  if (task.routineId) scope.automationId = task.routineId
  if (task.buddyId) scope.buddyId = task.buddyId
  if (task.skill) scope.skillId = task.skill
  return scope
}

const INHERITED = ['automationId', 'buddyId', 'skillId', 'ccSession'] as const

/**
 * The exact scope a background task runs in, fixed when it is created: its own ids, plus, for a
 * helper, the owner ids of its parent task's scope. Never the scope of whatever launches it from
 * the queue (a queued task starts when another one finishes, inside that one's context).
 */
export function taskUsageScope(
  task: Pick<BackgroundTask, 'id' | 'origin' | 'skill' | 'parentId' | 'routineId' | 'buddyId'>,
  parent?: UsageScope
): UsageScope {
  const own = usageScopeForTask(task) as UsageScope
  if (!task.parentId || !parent) return own
  const inherited: Partial<UsageScope> = {}
  for (const k of INHERITED) if (parent[k]) inherited[k] = parent[k]
  return { ...inherited, ...own }
}
