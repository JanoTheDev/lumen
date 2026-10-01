// Helper handoff (11 T24, F15) as a `.lumen` PackKind: a teacher, family member or caregiver
// exports lessons (and community labels for their apps) on their PC; the user opens the file
// on theirs. One pack folder "handoff-<name>" with handoff.json, lessons/*.lesson.json and
// labels/<app>.json. Data only. Installed like any community pack (marker, untrusted: the
// lessons lose "do it for me", labels never replace the user's own). No Electron.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { parseLabelsFile } from '../labels/store'
import { parseLesson, slug } from '../teach/lesson'
import type { PackKind } from './install'

export const HANDOFF_KIND = 'lesson-handoff'
export const HANDOFF_FILE = 'handoff.json'
export const HANDOFF_PREFIX = 'handoff-'
const LESSON_SUFFIX = '.lesson.json'
const MAX_LESSONS = 50

export const handoffSchema = z
  .object({
    format: z.literal(1),
    id: z
      .string()
      .regex(/^handoff-[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(70),
    title: z.string().min(1).max(80),
    /** Who made it ("Ms Jansen"), shown before install. */
    from: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
    createdAt: z.string().max(40),
    lessons: z.array(z.string().max(100)).max(MAX_LESSONS),
    labels: z.array(z.string().max(60)).max(50)
  })
  .strict()

export type Handoff = z.infer<typeof handoffSchema>

export function parseHandoff(raw: unknown): Handoff {
  return handoffSchema.parse(raw)
}

/** "handoff-blender-basics-for-sam" from a title; never empty. */
export function handoffId(title: string): string {
  return `${HANDOFF_PREFIX}${slug(title, 50) || 'lessons'}`
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

const zodText = (e: unknown): string =>
  e instanceof z.ZodError
    ? e.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')
    : (e as Error).message

export function handoffKind(): PackKind {
  return {
    name: HANDOFF_KIND,
    manifest: HANDOFF_FILE,
    allowedExt: ['.json', '.md', '.txt'],
    idOf(manifest) {
      return parseHandoff(JSON.parse(manifest.toString('utf8'))).id
    },
    reserved(id) {
      return id.startsWith(HANDOFF_PREFIX) ? null : `"${id}" must start with ${HANDOFF_PREFIX}`
    },
    validate(dir) {
      const problems: string[] = []
      let meta: Handoff | null = null
      try {
        meta = parseHandoff(readJson(join(dir, HANDOFF_FILE)))
      } catch (e) {
        return [`${HANDOFF_FILE}: ${zodText(e)}`]
      }
      if (meta.id !== dir.split(/[\\/]/).pop())
        problems.push(`${HANDOFF_FILE}: id must equal the folder name`)
      const lessonsDir = join(dir, 'lessons')
      const files = existsSync(lessonsDir) ? readdirSync(lessonsDir) : []
      for (const f of files) {
        if (!f.endsWith(LESSON_SUFFIX)) {
          problems.push(`lessons/${f}: not a lesson file`)
          continue
        }
        try {
          parseLesson(readJson(join(lessonsDir, f)))
        } catch (e) {
          problems.push(`lessons/${f}: ${zodText(e)}`)
        }
      }
      if (files.length > MAX_LESSONS) problems.push(`more than ${MAX_LESSONS} lessons`)
      const labelsDir = join(dir, 'labels')
      for (const f of existsSync(labelsDir) ? readdirSync(labelsDir) : []) {
        try {
          const file = parseLabelsFile(readJson(join(labelsDir, f)))
          if (!file || `${file.app}.json` !== f)
            problems.push(`labels/${f}: not a valid labels file`)
        } catch {
          problems.push(`labels/${f}: not JSON`)
        }
      }
      if (!files.length && !existsSync(labelsDir)) problems.push('no lessons and no labels')
      return problems
    }
  }
}
