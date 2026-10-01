// Skills in the agent loop (11 T02/T04, progressive disclosure): the L1 list as a cacheable
// system block, use_skill / read_skill_file (list_skills when the list was cut) as tools, and
// a skill's instructions preloaded when a trigger phrase or a task names it.
import type { ToolDef } from '../ai/providers/types'
import { getSkillRegistry } from '../skills'
import {
  createSkillToolHandlers,
  indexTruncated,
  skillIndexText,
  skillToolDefs,
  loadSkill,
  type SkillIndexContext
} from '../skills/disclosure'
import { skillAuthoringHandlers } from '../skills/agent-tools'
import type { LoadedSkill } from '../skills/registry'
import type { ToolHandler } from './runner'

export interface SkillToolSet {
  defs: ToolDef[]
  handlers: Record<string, ToolHandler>
  /** L1 list ('' when no skill is enabled or skills are not loaded). */
  index: string
}

export interface SkillToolOpts extends SkillIndexContext {
  /** Which skills this caller may load (default: enabled ones). */
  allow?: (s: LoadedSkill) => boolean
  onUse?: (s: LoadedSkill) => void
}

export function skillToolSet(opts: SkillToolOpts = {}): SkillToolSet {
  // create_skill / update_skill: only runs that list them (the foreground set) can call them.
  const authoring: Record<string, ToolHandler> = skillAuthoringHandlers()
  const registry = getSkillRegistry()
  if (!registry) return { defs: [], handlers: authoring, index: '' }
  const ctx: SkillIndexContext = { app: opts.app }
  const index = skillIndexText(registry, ctx)
  if (!index) return { defs: [], handlers: authoring, index: '' }
  const raw = createSkillToolHandlers(registry, {
    ...(opts.allow ? { allow: opts.allow } : {}),
    ...(opts.onUse ? { onUse: (s) => opts.onUse!(s) } : {})
  })
  const handlers: Record<string, ToolHandler> = { ...authoring }
  for (const [name, fn] of Object.entries(raw)) handlers[name] = (input) => fn(input)
  return { defs: skillToolDefs({ truncated: indexTruncated(registry, ctx) }), handlers, index }
}

/** The skill's instructions as use_skill returns them, for the first turn; null when unknown. */
export function preloadSkill(
  name: string,
  args?: { name: string; value: string }[]
): { name: string; text: string } | null {
  const registry = getSkillRegistry()
  if (!registry) return null
  const r = loadSkill(registry, { name, ...(args?.length ? { args } : {}) })
  if (r.isError) return null
  return { name, text: r.content.map((c) => c.text).join('\n') }
}

/** A skill by name (enabled only). */
export function enabledSkill(name: string): LoadedSkill | null {
  const registry = getSkillRegistry()
  const s = registry?.get(name)
  return s && registry!.isEnabled(s.manifest.name) ? s : null
}
