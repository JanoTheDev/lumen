// run_subagents (08 T49): one strict tool, a list of 1 to 6 jobs {role, task}. No optional
// parameters, so it costs nothing of Anthropic's request-wide strict budget.
import { z } from 'zod'
import type { ToolDef } from '../../ai/providers/types'
import { ROLE_NAMES, ROLES } from './roles'

export const MAX_JOBS = 6

export const runSubagentsInput = z.object({
  jobs: z
    .array(
      z.object({
        role: z.enum(ROLE_NAMES).describe('Which helper does the job.'),
        task: z
          .string()
          .describe(
            'The complete job for the helper; it does not see this conversation. Name the URLs, files and facts it needs.'
          )
      })
    )
    .describe('1 to 6 jobs; they run at the same time.')
})

export type RunSubagentsInput = z.infer<typeof runSubagentsInput>

const roleLines = ROLE_NAMES.map((r) => `${r}: ${ROLES[r].purpose}`).join('; ')

export const RUN_SUBAGENTS_TOOL: ToolDef = {
  name: 'run_subagents',
  description: `Hands 1 to 6 focused jobs to fast helpers that run at the same time and returns one short result per job (with the pages they read). Helpers cannot see the screen, ask the user or start helpers; one that needs something from the user says "needs: …". Roles: ${roleLines}. Use it for parallel research, reading several files or checking facts while you keep the overview.`,
  schema: runSubagentsInput
}
