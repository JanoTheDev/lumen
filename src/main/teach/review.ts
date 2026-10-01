// Review runs (plans 07 T29): a short "prove it" variant of a completed lesson. Up to three of
// its steps with the same checks; the runner points at nothing before the first hint. Reminder
// rules: only for the app in front, only when a card is due, at most one prompt a day. Pure.
import type { Lesson, LessonStep } from './lesson'
import type { Progress } from './progress'
import { isDue, localDay } from './srs'

export const REVIEW_MAX_STEPS = 3

/** Steps whose check runs by itself (anything but manual), in lesson order. */
function checked(steps: LessonStep[]): LessonStep[] {
  return steps.filter((s) => s.check.type !== 'manual')
}

/**
 * The review variant: the last (up to) three self-checking steps, the core of the lesson,
 * else its last three steps. Same id, so the run updates the lesson's card.
 */
export function reviewLesson(lesson: Lesson): Lesson {
  const auto = checked(lesson.steps)
  const pool = auto.length ? auto : lesson.steps
  const steps = pool.slice(-REVIEW_MAX_STEPS)
  const share = steps.length / Math.max(1, lesson.steps.length)
  return {
    ...lesson,
    title: `Review: ${lesson.title}`,
    minutes: Math.max(1, Math.round(lesson.minutes * share)),
    steps
  }
}

export interface DueReview {
  lessonId: string
  /** YYYY-MM-DD */
  due: string
}

/** Cards due today or earlier, most overdue first. */
export function dueReviews(p: Progress, now: number): DueReview[] {
  const today = localDay(now)
  return Object.entries(p.srs)
    .filter(([, c]) => isDue(c, today))
    .map(([lessonId, c]) => ({ lessonId, due: c.due }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.lessonId.localeCompare(b.lessonId))
}

/** Whether a review prompt may be shown now: reminders on and none shown today. */
export function mayPrompt(p: Progress, now: number, remindersOn: boolean): boolean {
  return remindersOn && p.reminders.lastPromptDay !== localDay(now)
}

/** The due review to offer for the app in front, if any (its lesson must still exist). */
export function reviewFor(
  p: Progress,
  now: number,
  appId: string,
  appOf: (lessonId: string) => string | null
): DueReview | null {
  return dueReviews(p, now).find((r) => appOf(r.lessonId) === appId) ?? null
}
