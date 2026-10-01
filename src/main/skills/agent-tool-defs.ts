// The agent's skill-making tools (11 F9), definitions only: create_skill proposes a new skill
// mid-task, update_skill changes one. Foreground agent mode only; every call ends in the bar's
// confirm card (agent-tools.ts), so nothing is saved without the user's yes. Strict subset:
// every field required, no bounds.
import { z } from 'zod'
import type { ToolDef } from '../ai/providers/types'

export const createSkillInput = z.object({
  name: z.string().describe('2 to 4 lowercase words joined by "-" ("weekly-report").'),
  description: z.string().describe('One sentence: what the skill does.'),
  triggers: z
    .array(z.string())
    .describe('1 to 3 short phrases the user could say to run it, lowercase.'),
  instructions: z
    .string()
    .describe(
      'Numbered steps in plain words for a later run: controls by visible name, never coordinates; {param} for values that change; ask the user when something is missing.'
    ),
  needs_input: z
    .boolean()
    .describe('true when it must click, type, press keys, open pages or start apps.'),
  websites: z
    .array(z.string())
    .describe('https origins it must open ("https://mail.google.com"); [] when none.'),
  why: z.string().describe('One short sentence for the user: why save this as a skill.')
})

export const updateSkillInput = z.object({
  name: z.string().describe('The skill to change, exactly as listed.'),
  change: z.string().describe('What to change, in plain words ("also open Slack at the end").')
})

export type CreateSkillInput = z.infer<typeof createSkillInput>
export type UpdateSkillInput = z.infer<typeof updateSkillInput>

export const CREATE_SKILL_TOOL = {
  name: 'create_skill',
  description:
    'Proposes saving a reusable skill (instructions for a task the user will likely ask again). Only when the user asks for it or the task clearly repeats; at most once per task. The user sees the skill on a confirm card and decides; the result says whether it was saved.',
  schema: createSkillInput
} satisfies ToolDef

export const UPDATE_SKILL_TOOL = {
  name: 'update_skill',
  description:
    'Proposes a change to one of the user’s skills (when a skill’s instructions were wrong or the user asks to change it). The user sees a summary of the change on a confirm card and decides.',
  schema: updateSkillInput
} satisfies ToolDef
