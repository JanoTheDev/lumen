// Saved guides → user lessons (plans 07 T19). Each ~/.ai-overlay/guides/*.json becomes a
// lesson under the lessons-only "general" app: the step label is what Lumen says, the target
// is the visible text to look for (the old bboxes are stale and in the wrong format, so they
// are dropped) and the check is manual ("done" / "next"). The original file moves to
// guides.bak/, so this runs once per guide and a guide saved later is picked up next start.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { SavedGuide } from '@shared/types'
import { parseLesson, slug, type Lesson, type StoredLesson } from './lesson'
import { freeLessonId, userLessonPath, writeUserLesson } from './user-lessons'

export const GUIDE_APP = 'general'

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Long enough for the lesson schema's minimum lengths. */
const atLeast = (s: string, min: number, fallback: string): string =>
  s.length >= min ? s : fallback

/** A short visible text to look for: the old target hint when it is short, else the label. */
function targetText(step: SavedGuide['steps'][number]): string {
  const hint = (step.target_hint ?? '').replace(/\s+/g, ' ').trim()
  return hint && hint.length <= 40 ? hint : clip(step.label, 40)
}

/** The lesson for one saved guide; null when it has no usable steps. */
export function guideToLesson(g: SavedGuide, id: string): Lesson | null {
  const steps = (g.steps ?? []).filter((s) => typeof s?.label === 'string' && s.label.trim())
  if (!steps.length) return null
  const used = new Set<string>()
  const stored: StoredLesson = {
    id,
    app: GUIDE_APP,
    title: atLeast(clip(g.name || g.task || '', 80), 3, 'Saved guide'),
    ...(g.task ? { summary: clip(g.task, 200) } : {}),
    level: 'beginner',
    minutes: Math.min(60, Math.max(1, Math.ceil(steps.length / 2))),
    prereqs: [],
    appVersion: 'any',
    tags: ['migrated-guide'],
    steps: steps.slice(0, 50).map((s, i) => {
      let sid = `step-${i + 1}-${slug(s.label, 24)}`
      while (used.has(sid)) sid = `${sid}-x`
      used.add(sid)
      const text = targetText(s)
      return {
        id: sid,
        say: atLeast(clip(s.label, 200), 3, `Step ${i + 1}.`),
        target: text.length ? { text } : null,
        hints: s.detail?.trim() ? [atLeast(clip(s.detail, 240), 3, 'Look around.')] : []
      }
    })
  }
  try {
    return parseLesson(stored)
  } catch {
    return null
  }
}

export interface MigrateResult {
  migrated: { guide: string; lessonId: string }[]
  failed: { file: string; reason: string }[]
}

/** Converts every guide file in `guidesDir` and moves the originals to `backupDir`. */
export function migrateGuides(dirs: {
  guidesDir: string
  lessonsDir: string
  backupDir: string
}): MigrateResult {
  const out: MigrateResult = { migrated: [], failed: [] }
  if (!existsSync(dirs.guidesDir)) return out
  let files: string[] = []
  try {
    files = readdirSync(dirs.guidesDir).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files.sort()) {
    const file = join(dirs.guidesDir, f)
    let guide: SavedGuide
    try {
      guide = JSON.parse(readFileSync(file, 'utf8')) as SavedGuide
    } catch (e) {
      out.failed.push({ file, reason: (e as Error).message })
      continue
    }
    const id = freeLessonId(dirs.lessonsDir, GUIDE_APP, guide.name || guide.task || 'guide')
    const lesson = guideToLesson(guide, id)
    if (!lesson || !userLessonPath(dirs.lessonsDir, id)) {
      out.failed.push({ file, reason: 'no usable steps' })
      continue
    }
    try {
      writeUserLesson(dirs.lessonsDir, lesson)
      mkdirSync(dirs.backupDir, { recursive: true })
      renameSync(file, join(dirs.backupDir, f))
      out.migrated.push({ guide: guide.name, lessonId: id })
    } catch (e) {
      out.failed.push({ file, reason: (e as Error).message })
    }
  }
  return out
}
