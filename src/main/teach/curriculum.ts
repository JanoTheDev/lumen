// Curriculum / skill tree (plans 07 T28): skills/<app>/curriculum.json orders a pack's lessons
// into units. A lesson is unlocked when all its prereqs are done; "what should I learn next"
// is the first unlocked lesson not done yet, in curriculum order. Packs without a curriculum
// use their lesson order (level, then file order). Pure: no Electron, no fs.
import { z } from 'zod'
import type { Lesson } from './lesson'

export interface CurriculumUnit {
  id: string
  title: string
  summary?: string
  lessons: string[]
}

export interface Curriculum {
  app: string
  units: CurriculumUnit[]
}

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

export const curriculumSchema = z
  .object({
    $schema: z.string().optional(),
    app: slug,
    units: z
      .array(
        z
          .object({
            id: slug,
            title: z.string().min(1).max(80),
            summary: z.string().max(240).optional(),
            lessons: z.array(z.string().min(1)).min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict()

/** The curriculum, or an error message (unknown ids, duplicates, prereq order). */
export function parseCurriculum(
  raw: unknown,
  lessons: Lesson[]
): { curriculum: Curriculum } | { error: string } {
  const r = curriculumSchema.safeParse(raw)
  if (!r.success)
    return {
      error: r.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')
    }
  const problems = curriculumProblems(r.data, lessons)
  if (problems.length) return { error: problems.join('; ') }
  const { app, units } = r.data
  return { curriculum: { app, units } }
}

/** Lesson ids that are unknown, listed twice, or come before one of their prereqs. */
export function curriculumProblems(c: Curriculum, lessons: Lesson[]): string[] {
  const byId = new Map(lessons.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of c.units)
    for (const id of u.lessons) {
      const l = byId.get(id)
      if (!l) out.push(`${u.id}: unknown lesson "${id}"`)
      else if (seen.has(id)) out.push(`${u.id}: "${id}" is listed twice`)
      else
        for (const p of l.prereqs)
          if (byId.has(p) && !seen.has(p))
            out.push(`${u.id}: "${id}" comes before its prereq "${p}"`)
      seen.add(id)
    }
  return out
}

export type LessonStatus = 'done' | 'next' | 'open' | 'locked'

export interface TreeLesson {
  lesson: Lesson
  unit: { id: string; title: string } | null
  status: LessonStatus
  /** Prereqs not done yet (locked lessons). */
  needs: string[]
}

const LEVEL_ORDER = { beginner: 0, intermediate: 1, advanced: 2 } as const

/**
 * A pack's lessons in learning order with their status. Curriculum units first (in order),
 * then lessons the curriculum leaves out. Prereqs outside the pack never lock a lesson.
 */
export function skillTree(
  lessons: Lesson[],
  curriculum: Curriculum | null | undefined,
  isDone: (id: string) => boolean
): TreeLesson[] {
  const byId = new Map(lessons.map((l) => [l.id, l]))
  const ordered: { lesson: Lesson; unit: TreeLesson['unit'] }[] = []
  const placed = new Set<string>()
  for (const u of curriculum?.units ?? [])
    for (const id of u.lessons) {
      const lesson = byId.get(id)
      if (!lesson || placed.has(id)) continue
      placed.add(id)
      ordered.push({ lesson, unit: { id: u.id, title: u.title } })
    }
  const rest = lessons
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !placed.has(l.id))
    .sort((a, b) => LEVEL_ORDER[a.l.level] - LEVEL_ORDER[b.l.level] || a.i - b.i)
  for (const { l } of rest) ordered.push({ lesson: l, unit: null })

  let nextFound = false
  return ordered.map(({ lesson, unit }) => {
    const needs = lesson.prereqs.filter((p) => byId.has(p) && !isDone(p))
    let status: LessonStatus
    if (isDone(lesson.id)) status = 'done'
    else if (needs.length) status = 'locked'
    else if (!nextFound) {
      status = 'next'
      nextFound = true
    } else status = 'open'
    return { lesson, unit, status, needs }
  })
}

/** The lesson to learn next in a pack, or null when every lesson is done. */
export function nextLesson(
  lessons: Lesson[],
  curriculum: Curriculum | null | undefined,
  isDone: (id: string) => boolean
): Lesson | null {
  return skillTree(lessons, curriculum, isDone).find((t) => t.status === 'next')?.lesson ?? null
}
