// Skill packs (skills/<app>/, CONTRACTS C8/C9) as a PackKind: data files only, validated with
// the same rules as the bundled packs (skills/schema/validate.mjs, also behind
// `npm run validate:skills`). No Electron: the schema folder and bundled ids come in.
import {
  NON_PACK_DIRS,
  loadSchemas,
  validatePackFolder,
  type Schemas
} from '../../../skills/schema/validate.mjs'
import type { PackKind } from './install'

export const SKILL_PACK_EXT = ['.json', '.md', '.txt', '.png', '.jpg', '.jpeg', '.webp'] as const

export interface SkillKindOptions {
  /** skills/schema inside the app. */
  schemaDir: string
  /** Ids of the packs that ship with Lumen (a community pack may not replace one). */
  bundledIds: () => Iterable<string>
  /** Lesson ids installed elsewhere that prereqs may name. */
  knownLessonIds?: () => Iterable<string>
}

export function skillPackKind(opts: SkillKindOptions): PackKind {
  let schemas: Schemas | null = null
  return {
    name: 'skill',
    manifest: 'skill.json',
    allowedExt: SKILL_PACK_EXT,
    plainNames: ['LICENSE', 'NOTICE', 'README'],
    idOf(manifest) {
      const id = (JSON.parse(manifest.toString('utf8')) as { id?: unknown })?.id
      if (typeof id !== 'string' || !id) throw new Error('skill.json has no id')
      return id
    },
    reserved(id) {
      if (NON_PACK_DIRS.has(id)) return `"${id}" is a reserved name`
      if ([...opts.bundledIds()].includes(id))
        return `a pack named "${id}" ships with Lumen and cannot be replaced`
      return null
    },
    validate(dir) {
      schemas ??= loadSchemas(opts.schemaDir)
      return validatePackFolder(dir, schemas, opts.knownLessonIds?.() ?? []).map((p) => {
        const rel = p.file.slice(dir.length + 1).replace(/\\/g, '/') || '.'
        return `${rel}: ${p.path}: ${p.message}`
      })
    }
  }
}
