// Lesson progress and resume (plans 07 T17): ~/.ai-overlay/teach/progress.json. The active
// lesson is written on every step change, so a crash or kill resumes on the same step.
// Writes are debounced (500 ms) and atomic (tmp file + rename). No Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { realClock, type Clock } from '../a11y/timings'
import type { Lesson } from './lesson'
import type { ProgressSink } from './runner'
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
  doItForMe: number
  skipped: number
}

export interface Progress {
  version: 1
  active?: ActiveLesson
  lessons: Record<string, LessonRecord>
  /** Spaced repetition cards (T29). */
  srs: Record<string, unknown>
}

export const emptyProgress = (): Progress => ({ version: 1, lessons: {}, srs: {} })

function sum(stats: Record<string, StepStats>, f: (s: StepStats) => number): number {
  return Object.values(stats).reduce((n, s) => n + f(s), 0)
}

/** The progress file after a lesson state change. */
export function applyState(prev: Progress, s: LessonState, now: number): Progress {
  const lesson = s.lesson
  if (!lesson || s.phase === 'idle') return prev
  if (s.phase === 'done') {
    const rec = prev.lessons[lesson.id] ?? {
      completedAt: [],
      bestTimeSec: 0,
      hintsUsed: 0,
      doItForMe: 0,
      skipped: 0
    }
    const started = prev.active?.lessonId === lesson.id ? prev.active.startedAt : now
    const timeSec = Math.max(1, Math.round((now - started) / 1000))
    return {
      version: 1,
      srs: prev.srs,
      lessons: {
        ...prev.lessons,
        [lesson.id]: {
          completedAt: [...rec.completedAt, now],
          bestTimeSec: rec.bestTimeSec ? Math.min(rec.bestTimeSec, timeSec) : timeSec,
          hintsUsed: rec.hintsUsed + sum(s.stats, (x) => x.hints),
          doItForMe: rec.doItForMe + sum(s.stats, (x) => (x.doItForMe ? 1 : 0)),
          skipped: rec.skipped + sum(s.stats, (x) => (x.skipped ? 1 : 0))
        }
      }
    }
  }
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

function isProgress(v: unknown): v is Progress {
  const p = v as Progress
  return !!p && p.version === 1 && typeof p.lessons === 'object' && !!p.lessons
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
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return isProgress(raw) ? { ...emptyProgress(), ...raw } : emptyProgress()
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
