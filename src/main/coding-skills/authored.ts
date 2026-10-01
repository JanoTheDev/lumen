// "Write a coding skill …" reuses Lumen's model-authored skills (skills/compose authorSkill):
// the request says the skill is for Claude Code working in a code project, and the draft it
// returns (description, when to use, instructions, reference files) is re-rendered as a
// Claude-format SKILL.md for the coding-skill library. Lumen-only fields (triggers,
// permissions, steps) are dropped: Claude Code does not read them.
import type { AuthorSkillRequest, AuthorSkillResult } from '../skills/compose'
import type { SkillFromModel } from './distill'
import { renderSkillMd, skillSlug } from './skillmd'

export type AuthorSkill = (req: AuthorSkillRequest) => Promise<AuthorSkillResult>

export const CODING_CONTEXT = [
  'This skill is for Claude Code, a coding agent working inside a software project, not for operating the PC.',
  'Write the instructions as coding guidance Claude reads while it edits code: conventions, file locations, APIs to use, commands to run, pitfalls, and what "done" looks like.',
  'needs_input false, websites [], apps [], connectors [], tools [], steps_json "", triggers [] and params [] are fine.'
].join(' ')

export async function skillFromAuthor(
  author: AuthorSkill,
  title: string,
  text: string
): Promise<SkillFromModel & { files: { path: string; text: string }[] }> {
  const r = await author({
    description: `${title}: ${text}`.slice(0, 2000),
    kind: 'coding',
    context: CODING_CONTEXT
  })
  if (!r.ok) throw new Error(r.error)
  const d = r.draft
  const name = skillSlug(title) !== 'skill' ? skillSlug(title) : skillSlug(d.name)
  const body = `# ${title}\n\n${d.instructions.trim()}`
  const files = (d.references ?? []).map((f) => ({ path: f.path, text: f.text }))
  return {
    name,
    title,
    description: d.description,
    ...(d.whenToUse ? { whenToUse: d.whenToUse } : {}),
    packages: [],
    sources: [],
    files,
    skillMd: renderSkillMd({ name, description: d.description, whenToUse: d.whenToUse, body })
  }
}
