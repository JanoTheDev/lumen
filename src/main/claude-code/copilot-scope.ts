// The usage scope of Lumen's own model calls for Claude Code (05 T43): autopilot answers and
// coding skills are Lumen's spend under origin claude-code-copilot, never the scope of whatever
// turn or hook started the session. Only the CLI's own result lines are external.
import { runInUsageScope, type UsageScope } from '../usage/scope'

export type CopilotFeature = 'autopilot' | 'coding-skill'

/** The Claude session (and its Tasks-list row) a call is for, so its cost joins that session's. */
export interface CopilotIds {
  ccSession?: string
  taskId?: string
}

export function copilotScope<T>(
  feature: CopilotFeature,
  fn: () => Promise<T>,
  ids: CopilotIds = {}
): Promise<T> {
  const scope: UsageScope = { origin: 'claude-code-copilot', feature }
  if (ids.ccSession) scope.ccSession = ids.ccSession
  if (ids.taskId) scope.taskId = ids.taskId
  return runInUsageScope(scope, fn)
}
