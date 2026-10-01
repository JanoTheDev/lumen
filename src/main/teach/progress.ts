// Lesson progress and resume (plans 07 T17, T27): ~/.ai-overlay/teach/progress.json. The active
// lesson is written on every step change, so a crash or kill resumes on the same step. A
// finished run updates the lesson record, the mastery of its tags and its SM-2 card (T29).
// Writes are debounced (500 ms) and atomic (tmp file + rename). No Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { realClock, type Clock } from '../a11y/timings'
import type { Lesson } from './lesson'
import { PRACTICE_LESSON_ID } from './practice-lesson'
import type { ProgressSink } from './runner'
import { isCard, localDay, runQuality, sm2, type SrsCard } from './srs'
import type { LessonSource, LessonState, StepStats } from './state'

export const RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const WRITE_DEBOUNCE_MS = 500

export interface ActiveLesson {
  lessonId: string
  stepId: string
  stepIndex: number
  source: LessonSource
  startedAt: number
  updatedAt: number
  /** Set while paused or stopped. */
  pausedAt?: number
  pace: number
  steps: Record<string, StepStats>
  /** The lesson itself when it was generated on the fly (not in any pack). */
  generated?: Lesson
}

export interface LessonRecord {
  completedAt: number[]
  bestTimeSec: number
  hintsUsed: number
  doItForMeCount: number
  skipped: number
  /** SM-2 quality (0-5) of the latest finished run, review or not. */
  lastQuality?: number
}

export interface Progress {
  version: 2
  active?: ActiveLesson
  lessons: Record<string, LessonRecord>
  /** Mastery 0-1 per "<app>:<tag>" (lesson tags), moved by every finished run (T27). */
  mastery: Record<string, number>
  /** SM-2 cards per lesson id (T29). */
  srs: Record<string, SrsCard>
  /** Review reminders: at most one prompt a day (T29). */
  reminders: { lastPromptDay?: string }
}

export const emptyProgress = (): Progress => ({
  version: 2,
  lessons: {},
  mastery: {},
  srs: {},
  reminders: {}
})

/** How far one run moves a tag's mastery towards its score (quality / 5). */
export const MASTERY_RATE = 0.5

/** Tags that say where a lesson came from, not what it teaches. */
const META_TAGS = new Set(['generated', 'saved', 'migrated-guide'])

export const masteryKey = (app: string, tag: string): string => `${app}:${tag}`

/** The skill tags a lesson's runs count towards. */
export function lessonSkills(lesson: Lesson): string[] {
  return (lesson.tags ?? []).filter((t) => !META_TAGS.has(t))
}

/** Whether finished runs of this lesson get a review card and move mastery. */
function tracked(lesson: Lesson, s: LessonState): boolean {
  return s.source !== 'generated' && lesson.id !== PRACTICE_LESSON_ID
}

function withMastery(
  prev: Record<string, number>,
  lesson: Lesson,
  quality: number
): Record<string, number> {
  const out = { ...prev }
  const score = quality / 5
  for (const tag of lessonSkills(lesson)) {
    const k = masteryKey(lesson.app, tag)
    const m = out[k] ?? 0
    out[k] = Math.round((m + MASTERY_RATE * (score - m)) * 1000) / 1000
  }
  return out
}

function sum(stats: Record<string, StepStats>, f: (s: StepStats) => number): number {
  return Object.values(stats).reduce((n, s) => n + f(s), 0)
}

function finished(prev: Progress, s: LessonState, lesson: Lesson, now: number): Progress {
  const quality = runQuality(s.stats)
  const keep = tracked(lesson, s)
  const srs = keep ? { ...prev.srs, [lesson.id]: sm2(prev.srs[lesson.id], quality, now) } : prev.srs
  const mastery = keep ? withMastery(prev.mastery, lesson, quality) : prev.mastery
  const rec = prev.lessons[lesson.id]
  // A review proves a lesson again: card, mastery and quality only. The record and the
  // lesson left part-way stay as they are.
  if (s.review) {
    const lessons = rec
      ? { ...prev.lessons, [lesson.id]: { ...rec, lastQuality: quality } }
      : prev.lessons
    return { ...prev, srs, mastery, lessons }
  }
  const base: LessonRecord = rec ?? {
    completedAt: [],
    bestTimeSec: 0,
    hintsUsed: 0,
    doItForMeCount: 0,
    skipped: 0
  }
  const started = prev.active?.lessonId === lesson.id ? prev.active.startedAt : now
  const timeSec = Math.max(1, Math.round((now - started) / 1000))
  return {
    ...prev,
    active: undefined,
    srs,
    mastery,
    lessons: {
      ...prev.lessons,
      [lesson.id]: {
        completedAt: [...base.completedAt, now],
        bestTimeSec: base.bestTimeSec ? Math.min(base.bestTimeSec, timeSec) : timeSec,
        hintsUsed: base.hintsUsed + sum(s.stats, (x) => x.hints),
        doItForMeCount: base.doItForMeCount + sum(s.stats, (x) => (x.doItForMe ? 1 : 0)),
        skipped: base.skipped + sum(s.stats, (x) => (x.skipped ? 1 : 0)),
        lastQuality: quality
      }
    }
  }
}

/** The progress file after a lesson state change. */
export function applyState(prev: Progress, s: LessonState, now: number): Progress {
  const lesson = s.lesson
  if (!lesson || s.phase === 'idle') return prev
  if (s.phase === 'done') return finished(prev, s, lesson, now)
  // Reviews are short and never resumed.
  if (s.review) return prev
  const paused = s.phase === 'paused' || s.phase === 'aborted'
  const same = prev.active?.lessonId === lesson.id
  const step = lesson.steps[s.index]
  const active: ActiveLesson = {
    lessonId: lesson.id,
    stepId: step.id,
    stepIndex: s.index,
    source: s.source,
    startedAt: same ? prev.active!.startedAt : now,
    updatedAt: now,
    pace: s.pace,
    steps: s.stats,
    ...(paused ? { pausedAt: same && prev.active!.pausedAt ? prev.active!.pausedAt : now } : {}),
    ...(s.source === 'generated' ? { generated: lesson } : {})
  }
  return { ...prev, active }
}

export interface ResumeOffer {
  lessonId: string
  lesson: Lesson
  stepIndex: number
  /** "Resume Blender: Add an object, step 3?" */
  text: string
  appName: string
}

/** A lesson left (paused, stopped or killed) less than 7 days ago, if it still exists. */
export function resumeOffer(
  p: Progress,
  now: number,
  find: (id: string) => { lesson: Lesson; appName: string } | null
): ResumeOffer | null {
  const a = p.active
  if (!a) return null
  const at = a.pausedAt ?? a.updatedAt
  if (!(now - at < RESUME_WINDOW_MS)) return null
  const found = a.generated ? { lesson: a.generated, appName: a.generated.app } : find(a.lessonId)
  if (!found) return null
  const { lesson, appName } = found
  // The step id wins over the index, so an edited lesson still lands on the right step.
  let stepIndex = lesson.steps.findIndex((s) => s.id === a.stepId)
  if (stepIndex < 0) stepIndex = Math.min(a.stepIndex, lesson.steps.length - 1)
  return {
    lessonId: lesson.id,
    lesson,
    stepIndex,
    appName,
    text: `Resume ${appName}: ${lesson.title}, step ${stepIndex + 1}?`
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function record(v: unknown): LessonRecord | null {
  if (!isObject(v)) return null
  const r: LessonRecord = {
    completedAt: Array.isArray(v.completedAt)
      ? v.completedAt.filter((x): x is number => typeof x === 'number')
      : [],
    bestTimeSec: num(v.bestTimeSec),
    hintsUsed: num(v.hintsUsed),
    // v1 called it doItForMe.
    doItForMeCount: num(v.doItForMeCount ?? v.doItForMe),
    skipped: num(v.skipped)
  }
  if (typeof v.lastQuality === 'number') r.lastQuality = v.lastQuality
  return r
}

/** A v1 or v2 file as v2; null when it is not a progress file. */
export function migrateProgress(raw: unknown): Progress | null {
  if (!isObject(raw) || (raw.version !== 1 && raw.version !== 2) || !isObject(raw.lessons))
    return null
  const out = emptyProgress()
  for (const [id, v] of Object.entries(raw.lessons)) {
    const r = record(v)
    if (r) out.lessons[id] = r
  }
  if (isObject(raw.srs))
    for (const [id, c] of Object.entries(raw.srs)) if (isCard(c)) out.srs[id] = c
  if (isObject(raw.mastery))
    for (const [k, m] of Object.entries(raw.mastery))
      if (typeof m === 'number' && m >= 0 && m <= 1) out.mastery[k] = m
  if (isObject(raw.reminders) && typeof raw.reminders.lastPromptDay === 'string')
    out.reminders.lastPromptDay = raw.reminders.lastPromptDay
  if (isObject(raw.active)) out.active = raw.active as unknown as ActiveLesson
  return out
}

export class ProgressStore implements ProgressSink {
  private data: Progress
  private timer: unknown = null

  constructor(
    private readonly file: string,
    private readonly clock: Clock = realClock,
    private readonly debounceMs = WRITE_DEBOUNCE_MS
  ) {
    this.data = this.read()
  }

  private read(): Progress {
    try {
      if (!existsSync(this.file)) return emptyProgress()
      return migrateProgress(JSON.parse(readFileSync(this.file, 'utf8'))) ?? emptyProgress()
    } catch {
      return emptyProgress()
    }
  }

  get(): Progress {
    return this.data
  }

  save(state: LessonState): void {
    this.data = applyState(this.data, state, this.clock.now())
    if (this.timer) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.write()
    }, this.debounceMs)
  }

  /** Forgets the active lesson (the user declined to resume or started another). */
  clearActive(): void {
    if (!this.data.active) return
    this.data = { ...this.data, active: undefined }
    this.flush()
  }

  /** Notes that today's review reminder was shown (at most one a day). */
  markPrompted(now: number): void {
    this.data = {
      ...this.data,
      reminders: { ...this.data.reminders, lastPromptDay: localDay(now) }
    }
    this.flush()
  }

  /** A practice challenge (11 T22) moves the mastery of its skill tags like a lesson run. */
  practice(app: string, skills: string[], quality: number): void {
    const out = { ...this.data.mastery }
    const score = Math.max(0, Math.min(5, quality)) / 5
    for (const tag of skills) {
      const k = masteryKey(app, tag)
      const m = out[k] ?? 0
      out[k] = Math.round((m + MASTERY_RATE * (score - m)) * 1000) / 1000
    }
    this.data = { ...this.data, mastery: out }
    this.flush()
  }

  /** Writes now (app quit). */
  flush(): void {
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.write()
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[teach] progress write failed:', (e as Error).message)
    }
  }
}
