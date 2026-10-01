import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reduce } from '../../src/main/teach/engine'
import { noopPorts } from '../../src/main/teach/ports'
import {
  ProgressStore,
  RESUME_WINDOW_MS,
  applyState,
  emptyProgress,
  resumeOffer
} from '../../src/main/teach/progress'
import { LessonRunner } from '../../src/main/teach/runner'
import { IDLE, type LessonEvent, type LessonState } from '../../src/main/teach/state'
import { LESSON } from './fixtures'

let dir: string
let file: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
  dir = mkdtempSync(join(tmpdir(), 'lumen-progress-'))
  file = join(dir, 'teach', 'progress.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function stateAfter(events: LessonEvent[]): LessonState {
  return events.reduce((s, e) => reduce(s, e).state, IDLE)
}

const find = (id: string): { lesson: typeof LESSON; appName: string } | null =>
  id === LESSON.id ? { lesson: LESSON, appName: 'Fake App' } : null

describe('applyState', () => {
  it('records the active step and the pause time', () => {
    const now = Date.now()
    const waiting = stateAfter([{ type: 'start', lesson: LESSON, stepIndex: 1 }])
    let p = applyState(emptyProgress(), waiting, now)
    expect(p.active).toMatchObject({ lessonId: LESSON.id, stepId: 'save', stepIndex: 1 })
    expect(p.active?.pausedAt).toBeUndefined()
    const paused = reduce(waiting, { type: 'command', command: 'pause' }).state
    p = applyState(p, paused, now + 5000)
    expect(p.active?.pausedAt).toBe(now + 5000)
    expect(p.active?.startedAt).toBe(now)
  })

  it('moves a finished lesson into the record', () => {
    const s0 = stateAfter([
      { type: 'start', lesson: LESSON, stepIndex: 2 },
      { type: 'command', command: 'help' }
    ])
    const done = reduce(s0, { type: 'command', command: 'skip' }).state
    expect(done.phase).toBe('done')
    const p = applyState(applyState(emptyProgress(), s0, 0), done, 90_000)
    expect(p.active).toBeUndefined()
    expect(p.lessons[LESSON.id]).toMatchObject({
      completedAt: [90_000],
      bestTimeSec: 90,
      hintsUsed: 1,
      skipped: 1
    })
  })
})

describe('resumeOffer', () => {
  it('offers a lesson paused less than 7 days ago', () => {
    const s = stateAfter([
      { type: 'start', lesson: LESSON, stepIndex: 2 },
      { type: 'command', command: 'pause' }
    ])
    const p = applyState(emptyProgress(), s, 1000)
    const offer = resumeOffer(p, 1000 + RESUME_WINDOW_MS - 1, find)
    expect(offer?.text).toBe('Resume Fake App: Three steps, step 3?')
    expect(offer?.stepIndex).toBe(2)
    expect(resumeOffer(p, 1000 + RESUME_WINDOW_MS, find)).toBeNull()
  })

  it('finds the step by id when the lesson changed', () => {
    const p = applyState(
      emptyProgress(),
      stateAfter([{ type: 'start', lesson: LESSON, stepIndex: 1 }]),
      0
    )
    const edited = { ...LESSON, steps: [LESSON.steps[1], LESSON.steps[2]] }
    const offer = resumeOffer(p, 10, () => ({ lesson: edited, appName: 'X' }))
    expect(offer?.stepIndex).toBe(0)
  })

  it('nothing to offer for a deleted lesson', () => {
    const p = applyState(emptyProgress(), stateAfter([{ type: 'start', lesson: LESSON }]), 0)
    expect(resumeOffer(p, 10, () => null)).toBeNull()
  })
})

describe('ProgressStore', () => {
  it('debounces writes and writes atomically', async () => {
    const store = new ProgressStore(file)
    const s = stateAfter([{ type: 'start', lesson: LESSON, stepIndex: 1 }])
    store.save(s)
    store.save(s)
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).active.stepId).toBe('save')
  })

  it('a corrupt file starts fresh', () => {
    const store0 = new ProgressStore(file)
    store0.flush()
    writeFileSync(file, '{nope')
    expect(new ProgressStore(file).get()).toEqual(emptyProgress())
  })

  it('kill mid-lesson and restart: resume lands on the same step', async () => {
    const store = new ProgressStore(file)
    const runner = new LessonRunner(noopPorts(), { progress: store })
    runner.start(LESSON, { autoStart: true })
    runner.command('skip')
    runner.command('skip')
    await vi.advanceTimersByTimeAsync(500)
    // "Kill": no pause, no flush beyond the debounced write. A new process reads the file.
    const reopened = new ProgressStore(file)
    const offer = resumeOffer(reopened.get(), Date.now(), find)
    expect(offer?.stepIndex).toBe(2)
    expect(offer?.lesson.steps[offer.stepIndex].id).toBe('look')
    const runner2 = new LessonRunner(noopPorts(), { progress: reopened })
    runner2.start(offer!.lesson, {
      stepIndex: offer!.stepIndex,
      stats: reopened.get().active?.steps
    })
    expect(runner2.state.index).toBe(2)
    expect(runner2.state.stats.open.skipped).toBe(true)
  })

  it('clearActive forgets the offer', () => {
    const store = new ProgressStore(file)
    store.save(stateAfter([{ type: 'start', lesson: LESSON }]))
    store.clearActive()
    expect(new ProgressStore(file).get().active).toBeUndefined()
  })
})
