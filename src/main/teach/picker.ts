// Lesson picker data (plans 07 T22, T27, T28): the list for Settings / Home / voice in skill
// tree order, and the "continue learning" view of the progress file (lesson to continue, recent
// completions, mastery and the next lesson per app, due reviews). Pure: registry, progress and
// runner state come in.
import type { LearningApp, LessonListItem, LessonProgressView } from '@shared/channels'
import { skillTree, type TreeLesson } from './curriculum'
import type { Lesson } from './lesson'
import type { Progress } from './progress'
import { lessonSkills, masteryKey, resumeOffer } from './progress'
import { hasMatchRules, type Skill } from './registry'
import { dueReviews } from './review'
import { isRunning, type LessonState } from './state'

const RECENT = 5

const doneIn = (progress: Progress) => (id: string) =>
  (progress.lessons[id]?.completedAt.length ?? 0) > 0

function lessonItem(
  t: TreeLesson,
  skill: Skill,
  progress: Progress,
  source: LessonListItem['source'],
  due: ReadonlySet<string>
): LessonListItem {
  const { lesson } = t
  const title = (id: string): string => skill.lessons.find((l) => l.id === id)?.title ?? id
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
    completed: progress.lessons[lesson.id]?.completedAt.length ?? 0,
    ...(t.unit ? { unit: t.unit } : {}),
    status: t.status,
    ...(t.needs.length ? { needs: t.needs.map(title) } : {}),
    ...(due.has(lesson.id) ? { reviewDue: true } : {}),
    ...(skill.trust && source === 'pack' ? { community: true } : {})
  }
}

/** Every lesson (or one app's), apps by name, lessons in skill tree order. */
export function lessonList(
  skills: Skill[],
  progress: Progress,
  userIds: ReadonlySet<string>,
  appId?: string,
  now = Date.now()
): LessonListItem[] {
  const due = new Set(dueReviews(progress, now).map((r) => r.lessonId))
  return skills
    .filter((s) => !appId || s.id === appId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((s) =>
      skillTree(s.lessons, s.curriculum, doneIn(progress)).map((t) =>
        lessonItem(t, s, progress, userIds.has(t.lesson.id) ? 'user' : 'pack', due)
      )
    )
}

/** Mean mastery of the skills (lesson tags) an app's lessons teach; 0 when it has none. */
export function appMastery(skill: Skill, progress: Progress): number {
  const tags = new Set(skill.lessons.flatMap(lessonSkills))
  if (!tags.size) return 0
  let total = 0
  for (const t of tags) total += progress.mastery[masteryKey(skill.id, t)] ?? 0
  return Math.round((total / tags.size) * 100) / 100
}

export function learningApps(skills: Skill[], progress: Progress): LearningApp[] {
  const isDone = doneIn(progress)
  return skills
    .filter((s) => s.lessons.length && hasMatchRules(s))
    .map((s) => {
      const tree = skillTree(s.lessons, s.curriculum, isDone)
      const next = tree.find((t) => t.status === 'next')?.lesson
      return {
        appId: s.id,
        appName: s.name,
        mastery: appMastery(s, progress),
        completed: tree.filter((t) => t.status === 'done').length,
        total: tree.length,
        next: next ? { lessonId: next.id, title: next.title } : null
      }
    })
    .sort(
      (a, b) =>
        Number(b.completed > 0) - Number(a.completed > 0) || a.appName.localeCompare(b.appName)
    )
}

export function progressView(
  progress: Progress,
  running: LessonState | null,
  now: number,
  find: (id: string) => { lesson: Lesson; skill: Skill } | null,
  skills: Skill[] = []
): LessonProgressView {
  const appName = (id: string, fallback: string): string => find(id)?.skill.name ?? fallback
  let active: LessonProgressView['active'] = null
  if (running && isRunning(running) && running.lesson && !running.review) {
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
  const reviews = dueReviews(progress, now).flatMap((r) => {
    const f = find(r.lessonId)
    return f
      ? [{ lessonId: r.lessonId, title: f.lesson.title, appName: f.skill.name, due: r.due }]
      : []
  })
  return { active, recent, apps: learningApps(skills, progress), reviews }
}
