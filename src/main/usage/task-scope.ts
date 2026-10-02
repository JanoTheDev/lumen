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
