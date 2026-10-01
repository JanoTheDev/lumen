// The user's own lessons (~/.ai-overlay/skills/user/lessons/*.lesson.json): saved "show me
// how" lessons and migrated guides. Files are written atomically (tmp + rename). No Electron.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { slug, toStoredLesson, type Lesson } from './lesson'

export const LESSON_FILE_SUFFIX = '.lesson.json'
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** The file for a lesson id inside `dir`, or null when the id is malformed. */
export function userLessonPath(dir: string, id: string): string | null {
  if (!ID_RE.test(id) || id.length > 100) return null
  const root = resolve(dir)
  const file = resolve(root, `${id}${LESSON_FILE_SUFFIX}`)
  return file.startsWith(root + sep) ? file : null
}

/** A lesson id for `title` under `app` that no file in `dir` uses yet. */
export function freeLessonId(dir: string, app: string, title: string): string {
  const base = `${app}-${slug(title, 40)}`
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const file = userLessonPath(dir, id)
    if (file && !existsSync(file)) return id
  }
  return `${base}-${Date.now().toString(36)}`
}

export function writeUserLesson(dir: string, lesson: Lesson): string {
  const file = userLessonPath(dir, lesson.id)
  if (!file) throw new Error(`invalid lesson id: ${lesson.id}`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(toStoredLesson(lesson), null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

export function deleteUserLesson(dir: string, id: string): boolean {
  const file = userLessonPath(dir, id)
  if (!file) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export function userLessonsDir(skillsRoot: string): string {
  return join(skillsRoot, 'user', 'lessons')
}
