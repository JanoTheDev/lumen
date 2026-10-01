import { describe, expect, it } from 'vitest'
import { reduce } from '../../src/main/teach/engine'
import { LEVEL } from '../../src/main/teach/hints'
import type { Lesson } from '../../src/main/teach/lesson'
import {
  applyState,
  emptyProgress,
  masteryKey,
  migrateProgress,
  type Progress
} from '../../src/main/teach/progress'
import { dueReviews, mayPrompt, reviewFor, reviewLesson } from '../../src/main/teach/review'
import { sm2 } from '../../src/main/teach/srs'
import { IDLE, type LessonEvent, type LessonState } from '../../src/main/teach/state'
import { LESSON } from './fixtures'

const NOW = new Date(2026, 9, 1, 10).getTime()
const DAY = 24 * 60 * 60 * 1000

const TAGGED: Lesson = { ...LESSON, tags: ['menus', 'saving', 'saved'] }

function stateAfter(events: LessonEvent[]): LessonState {
  return events.reduce((s, e) => reduce(s, e).state, IDLE)
}

/** Runs the lesson to the end; `help` hints on the first step. */
function finished(
  lesson: Lesson,
  opts: { review?: boolean; help?: number; doIt?: boolean } = {}
): { start: LessonState; done: LessonState } {
  let s = stateAfter([{ type: 'start', lesson, autoStart: true, review: opts.review }])
  const path: LessonState[] = [s]
  for (let i = 0; i < (opts.help ?? 0); i++)
    s = reduce(s, { type: 'command', command: 'help' }).state
  if (opts.doIt) {
    s = reduce(s, { type: 'command', command: 'do-it' }).state
    s = reduce(s, { type: 'do-it-done', step: 0, ok: true }).state
    s = reduce(s, { type: 'timer', id: 'advance' }).state
  }
  while (s.phase !== 'done') {
    if (s.phase === 'step.passed') s = reduce(s, { type: 'timer', id: 'advance' }).state
    else s = reduce(s, { type: 'check', step: s.index, result: 'pass' }).state
    path.push(s)
  }
  return { start: path[0], done: s }
}

describe('progress v2 (T27)', () => {
  it('a finished lesson: record, mastery per app:tag (meta tags ignored), SM-2 card', () => {
    const { start, done } = finished(TAGGED)
    let p = applyState(emptyProgress(), start, NOW)
    p = applyState(p, done, NOW + 60_000)
    expect(p.lessons[LESSON.id]).toMatchObject({
      completedAt: [NOW + 60_000],
      bestTimeSec: 60,
      hintsUsed: 0,
      doItForMeCount: 0,
      lastQuality: 5
    })
    expect(p.mastery).toEqual({ [masteryKey('fake', 'menus')]: 0.5, 'fake:saving': 0.5 })
    expect(p.srs[LESSON.id]).toMatchObject({ reps: 1, interval: 1, due: '2026-10-02' })
    expect(p.active).toBeUndefined()
  })

  it('mastery moves towards the run score; do-it-for-me scores low', () => {
    let p = emptyProgress()
    p = applyState(p, finished(TAGGED).done, NOW)
    p = applyState(p, finished(TAGGED).done, NOW)
    expect(p.mastery['fake:menus']).toBe(0.75)
    p = applyState(p, finished(TAGGED, { doIt: true }).done, NOW)
    expect(p.mastery['fake:menus']).toBe(0.575)
    expect(p.lessons[LESSON.id].doItForMeCount).toBe(1)
    expect(p.srs[LESSON.id]).toMatchObject({ reps: 0, interval: 1 })
  })

  it('generated lessons get no card and no mastery', () => {
    const s = finished(TAGGED).done
    const p = applyState(emptyProgress(), { ...s, source: 'generated' }, NOW)
    expect(p.srs).toEqual({})
    expect(p.mastery).toEqual({})
    expect(p.lessons[LESSON.id].completedAt).toHaveLength(1)
  })

  it('migrates a v1 file (doItForMe → doItForMeCount, junk srs dropped)', () => {
    const p = migrateProgress({
      version: 1,
      lessons: {
        x: { completedAt: [1, 2], bestTimeSec: 30, hintsUsed: 2, doItForMe: 1, skipped: 0 }
      },
      srs: { x: { nope: true } }
    })!
    expect(p.version).toBe(2)
    expect(p.lessons.x).toEqual({
      completedAt: [1, 2],
      bestTimeSec: 30,
      hintsUsed: 2,
      doItForMeCount: 1,
      skipped: 0
    })
    expect(p.srs).toEqual({})
    expect(p.mastery).toEqual({})
    expect(migrateProgress({ version: 3, lessons: {} })).toBeNull()
  })
})

describe('reviews (T29)', () => {
  it('the review variant: last three self-checking steps, same id', () => {
    const r = reviewLesson(LESSON)
    // LESSON's last step is manual; the other two check themselves.
    expect(r.steps.map((s) => s.id)).toEqual(['open', 'save'])
    expect(r.id).toBe(LESSON.id)
    expect(r.title).toBe('Review: Three steps')
    expect(r.minutes).toBe(2)
  })

  it('a review run says the step without pointing, and points from the first hint', () => {
    const t = reduce(IDLE, { type: 'start', lesson: LESSON, autoStart: true, review: true })
    expect(t.state.level).toBe(LEVEL.SAY)
    expect(t.effects).toContainEqual({ type: 'point', step: 0, level: LEVEL.SAY })
    const timer = reduce(t.state, { type: 'timer', id: 'hint' })
    expect(timer.state.level).toBe(LEVEL.HINT)
  })

  it('a finished review updates card and mastery, not the record or the paused lesson', () => {
    let p = applyState(emptyProgress(), finished(TAGGED).done, NOW)
    const other = stateAfter([
      { type: 'start', lesson: { ...LESSON, id: 'fake-other' }, stepIndex: 1 },
      { type: 'command', command: 'pause' }
    ])
    p = applyState(p, other, NOW + 1)
    const { start, done } = finished(TAGGED, { review: true, help: 1 })
    p = applyState(p, start, NOW + DAY)
    expect(p.active?.lessonId).toBe('fake-other')
    p = applyState(p, done, NOW + DAY)
    expect(p.active?.lessonId).toBe('fake-other')
    expect(p.lessons[LESSON.id].completedAt).toHaveLength(1)
    expect(p.lessons[LESSON.id].lastQuality).toBe(4)
    expect(p.srs[LESSON.id]).toMatchObject({ reps: 2, interval: 6, due: '2026-10-08' })
  })

  it('due reviews, most overdue first; one prompt a day', () => {
    const p: Progress = {
      ...emptyProgress(),
      srs: {
        a: sm2(undefined, 5, NOW - 3 * DAY),
        b: sm2(undefined, 5, NOW - 5 * DAY),
        c: sm2(undefined, 5, NOW)
      }
    }
    expect(dueReviews(p, NOW).map((r) => r.lessonId)).toEqual(['b', 'a'])
    const appOf = (id: string): string => (id === 'a' ? 'blender' : 'obs')
    expect(reviewFor(p, NOW, 'blender', appOf)?.lessonId).toBe('a')
    expect(reviewFor(p, NOW, 'excel', appOf)).toBeNull()
    expect(mayPrompt(p, NOW, true)).toBe(true)
    expect(mayPrompt(p, NOW, false)).toBe(false)
    const prompted = { ...p, reminders: { lastPromptDay: '2026-10-01' } }
    expect(mayPrompt(prompted, NOW, true)).toBe(false)
    expect(mayPrompt(prompted, NOW + DAY, true)).toBe(true)
  })
})
