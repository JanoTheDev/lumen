// The usage scope of Lumen's own model calls for Claude Code (05 T43): autopilot answers and
// coding skills are Lumen's spend under origin claude-code-copilot, never the scope of whatever
// turn or hook started the session. Only the CLI's own result lines are external.
import { runInUsageScope } from '../usage/scope'

export type CopilotFeature = 'autopilot' | 'coding-skill'

export function copilotScope<T>(feature: CopilotFeature, fn: () => Promise<T>): Promise<T> {
  return runInUsageScope({ origin: 'claude-code-copilot', feature }, fn)
}
