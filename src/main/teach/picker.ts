// Lesson picker data (plans 07 T22): the list for Settings / Home / voice, and the "continue
// learning" view of the progress file. Pure: registry, progress and runner state come in.
import type { LessonListItem, LessonProgressView } from '@shared/channels'
import type { Lesson } from './lesson'
import type { Progress } from './progress'
import { resumeOffer } from './progress'
import type { Skill } from './registry'
import { isRunning, type LessonState } from './state'

const LEVEL_ORDER = { beginner: 0, intermediate: 1, advanced: 2 } as const
const RECENT = 5

export function lessonItem(
  lesson: Lesson,
  skill: Skill,
  progress: Progress,
  source: LessonListItem['source']
): LessonListItem {
  return {
    id: lesson.id,
    title: lesson.title,
    ...(lesson.summary ? { summary: lesson.summary } : {}),
    appId: skill.id,
    appName: skill.name,
    level: lesson.level,
    minutes: lesson.minutes,
    steps: lesson.steps.length,
    source,
    completed: progress.lessons[lesson.id]?.completedAt.length ?? 0
  }
}

/** Every lesson (or one app's), apps by name, lessons by level then their pack order. */
export function lessonList(
  skills: Skill[],
  progress: Progress,
  userIds: ReadonlySet<string>,
  appId?: string
): LessonListItem[] {
  return skills
    .filter((s) => !appId || s.id === appId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((s) =>
      s.lessons
        .map((l, i) => ({ l, i }))
        .sort((a, b) => LEVEL_ORDER[a.l.level] - LEVEL_ORDER[b.l.level] || a.i - b.i)
        .map(({ l }) => lessonItem(l, s, progress, userIds.has(l.id) ? 'user' : 'pack'))
    )
}

export function progressView(
  progress: Progress,
  running: LessonState | null,
  now: number,
  find: (id: string) => { lesson: Lesson; skill: Skill } | null
): LessonProgressView {
  const appName = (id: string, fallback: string): string => find(id)?.skill.name ?? fallback
  let active: LessonProgressView['active'] = null
  if (running && isRunning(running) && running.lesson) {
    const l = running.lesson
    active = {
      lessonId: l.id,
      title: l.title,
      appName: appName(l.id, l.app),
      step: running.index + 1,
      total: l.steps.length,
      running: true
    }
  } else {
    const o = resumeOffer(progress, now, (id) => {
      const f = find(id)
      return f ? { lesson: f.lesson, appName: f.skill.name } : null
    })
    if (o)
      active = {
        lessonId: o.lessonId,
        title: o.lesson.title,
        appName: o.appName,
        step: o.stepIndex + 1,
        total: o.lesson.steps.length,
        running: false
      }
  }
  const recent = Object.entries(progress.lessons)
    .flatMap(([id, rec]) => {
      const at = rec.completedAt.at(-1)
      const f = find(id)
      return at && f
        ? [{ lessonId: id, title: f.lesson.title, appName: f.skill.name, completedAt: at }]
        : []
    })
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, RECENT)
  return { active, recent }
}
