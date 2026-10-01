// Handlers for create_skill / update_skill (agent-tool-defs.ts). Each call goes to the skill
// making instance, which checks the skill and asks on the bar's confirm card; at most one of
// each per task, so a model cannot keep asking. The instance is set by installSkillCreation, so
// this module stays free of Electron imports.
import { createSkillInput, updateSkillInput } from './agent-tool-defs'

/** What the tools need from skill making (creation.ts). */
export interface SkillAuthoringHost {
  proposeFromAgent(input: {
    name: string
    description: string
    triggers: string[]
    instructions: string
    needs_input: boolean
    websites: string[]
    why: string
  }): Promise<{ ok: boolean; text: string }>
  editFromAgent(name: string, change: string): Promise<{ ok: boolean; text: string }>
}

let host: SkillAuthoringHost | null = null

export function setSkillAuthoringHost(h: SkillAuthoringHost | null): void {
  host = h
}

interface Outcome {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

type Handler = (input: Record<string, unknown>) => Promise<Outcome>

const text = (t: string, isError = false): Outcome => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError } : {})
})

/** Fresh handlers for one agent task (their per-task counters start at zero). */
export function skillAuthoringHandlers(
  get: () => SkillAuthoringHost | null = () => host
): Record<'create_skill' | 'update_skill', Handler> {
  let creates = 0
  let updates = 0
  return {
    create_skill: async (input) => {
      const p = createSkillInput.safeParse(input)
      if (!p.success) return text('Invalid input.', true)
      const c = get()
      if (!c) return text('Skills are not ready.', true)
      if (creates++ >= 1) return text('Only one new skill per task. Go on with the task.', true)
      const r = await c.proposeFromAgent(p.data)
      return text(r.text, !r.ok)
    },
    update_skill: async (input) => {
      const p = updateSkillInput.safeParse(input)
      if (!p.success) return text('Invalid input.', true)
      const c = get()
      if (!c) return text('Skills are not ready.', true)
      if (updates++ >= 1) return text('Only one skill change per task. Go on with the task.', true)
      const r = await c.editFromAgent(p.data.name, p.data.change)
      return text(r.text, !r.ok)
    }
  }
}
