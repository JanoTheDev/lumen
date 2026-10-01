// Types for validate.mjs (shared skill pack validation).

export interface Problem {
  file: string
  path: string
  message: string
}

export interface Schemas {
  skill: object
  regions: object
  lesson: object
  curriculum: object
  bridgeKeys: Record<string, unknown>
}

export const NON_PACK_DIRS: Set<string>
export const LIMITS: {
  overviewTokens: number
  shortcutsTokens: number
  glossaryTokens: number
  sayWords: number
  hintWords: number
  whyWords: number
}

export function estimateTokens(text: string): number
export function loadSchemas(schemaDir: string): Schemas
export function validateSchema(
  value: unknown,
  schema: object,
  root?: object,
  path?: string
): { path: string; message: string }[]
export function bridgeExpectProblems(
  check: { app: string; expect?: Record<string, unknown> },
  bridgeKeys: Record<string, unknown>
): string[]
/** One pack folder on its own; prereqs may name `knownLessonIds`. */
export function validatePackFolder(
  packDir: string,
  schemas: Schemas,
  knownLessonIds?: Iterable<string>
): Problem[]
export function validateSkillsDir(
  skillsDir: string,
  schemas: Schemas
): { errors: Problem[]; packs: string[]; lessons: number }
