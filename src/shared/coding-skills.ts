// Coding skills for the Claude Code copilot: Claude-format skills (SKILL.md) kept in Lumen's
// library, attached per project and handed to Lumen-started Claude Code sessions through a
// Lumen-managed plugin folder (never written into the project unless the user asks).
import { z } from 'zod'

/** Lowercase letters, digits and hyphens (Claude's skill name rule), max 64. */
export const CODING_SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export type CodingSkillSource =
  | { kind: 'docs'; urls: string[] }
  | { kind: 'import'; from: string }
  | { kind: 'written' }

export interface CodingSkillInfo {
  name: string
  /** Display name ("Better Auth"). */
  title: string
  description: string
  source: CodingSkillSource
  /** Package names this skill is about (npm / PyPI / crates), for project suggestions. */
  packages: string[]
  /** Library or docs version the skill was written for, if known. */
  version?: string
  updatedAt: number
}

/** A skill waiting for the user's review (save / discard). */
export interface CodingSkillDraft {
  id: string
  name: string
  title: string
  description: string
  /** The full SKILL.md as it will be saved. */
  skillMd: string
  source: CodingSkillSource
  packages: string[]
  version?: string
  /** Extra files of an imported skill (relative path → text), saved next to SKILL.md. */
  files: { path: string; text: string }[]
  /** Lines the user should look at before saving (commands, odd instructions). */
  warnings: string[]
  /** An update of an existing skill: a line diff against the saved SKILL.md. */
  update?: { diff: string; changed: boolean }
  createdAt: number
}

export interface DetectedDependency {
  ecosystem: 'npm' | 'pypi' | 'cargo'
  name: string
  version?: string
  /** The manifest it came from, relative to the project ("package.json", "apps/web/package.json"). */
  file: string
}

export interface CodingSkillSuggestion {
  /** The library skill to attach, or the catalog topic to create one for. */
  name: string
  title: string
  /** Why: the dependency that matched ("next 15.2 in package.json"). */
  reason: string
  /** In the library already (attach) or not yet (add from docs). */
  inLibrary: boolean
  docsUrl?: string
}

export interface CodingSkillsProject {
  path: string
  attached: string[]
  suggestions: CodingSkillSuggestion[]
}

export interface CodingSkillsOverview {
  library: CodingSkillInfo[]
  draft: CodingSkillDraft | null
  /** Where the library lives on disk. */
  dir: string
}

export type CodingSkillResult = { ok: boolean; error?: string; draft?: CodingSkillDraft }

const name = z.string().regex(CODING_SKILL_NAME_RE)
const path = z.string().min(1).max(1024)

export const codingSkillNameSchema = name
export const codingSkillPathSchema = path

/** `project`: attach the skill to this project once it is saved. */
export const codingSkillDocsSchema = z.object({
  url: z.string().min(8).max(2000).optional(),
  title: z.string().min(1).max(80).optional(),
  project: path.optional()
})

export const codingSkillImportSchema = z.object({
  from: z.string().min(1).max(2000),
  pick: z.string().min(1).max(80).optional(),
  project: path.optional()
})

export const codingSkillWriteSchema = z.object({
  title: z.string().min(1).max(80),
  text: z.string().min(1).max(20_000),
  project: path.optional()
})

export const codingSkillEditSchema = z.object({ name, skillMd: z.string().min(1).max(100_000) })

export const codingSkillSaveSchema = z.object({
  id: z.string().min(1).max(80),
  skillMd: z.string().min(1).max(100_000).optional()
})

export const codingSkillAttachSchema = z.object({
  project: path,
  names: z.array(name).min(1).max(30)
})

export const codingSkillDetachSchema = z.object({ project: path, name })
