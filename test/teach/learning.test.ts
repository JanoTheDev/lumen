import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_V2, type ConfigV2 } from '../../src/shared/config'
import {
  matchCoach,
  matchLearnNext,
  matchStartIt,
  matchStopReminding
} from '../../src/main/teach/commands'
import {
  createLearning,
  NEXT_OFFER_DELAY_MS,
  REMINDER_POLL_MS,
  type Learning,
  type LearningDeps
} from '../../src/main/teach/learning'
import { noopPorts } from '../../src/main/teach/ports'
import { ProgressStore } from '../../src/main/teach/progress'
import { SkillRegistry } from '../../src/main/teach/registry'
import { LessonRunner } from '../../src/main/teach/runner'
import { sm2 } from '../../src/main/teach/srs'

const HANDLED = { handled: true }
const BLENDER_1 = 'blender-basics-01-navigate-viewport'
const BLENDER_2 = 'blender-basics-02-add-transform'

// Loaded once: reading every shipped pack is slow under a full parallel test run.
const registry = new SkillRegistry({ builtin: join(__dirname, '..', '..', 'skills') }).load()

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 1, 10))
  dir = mkdtempSync(join(tmpdir(), 'lumen-learning-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

type Fn = ReturnType<typeof vi.fn>
interface Fake {
  registry: SkillRegistry
  store: ProgressStore
  runner: LessonRunner
  teach: ConfigV2['teach']
  deps: LearningDeps & {
    setReminders: Fn
    startLesson: Fn
    foreground: Fn
    idleSeconds: Fn
    show: Fn
    say: Fn
  }
  learning: Learning
}

function setup(window: { process: string; title: string } | null = null): Fake {
  const store = new ProgressStore(join(dir, 'progress.json'))
  const runner = new LessonRunner(noopPorts(), { progress: store })
  const teach = { ...DEFAULT_CONFIG_V2.teach }
  const deps = {
    registry: () => registry,
    store: () => store,
    runner: () => runner,
    config: () => teach,
    setReminders: vi.fn((on: boolean) => {
      teach.reviewReminders = on
    }),
    startLesson: vi.fn((id: string) => {
      const f = registry.lesson(id)
      if (f) runner.start(f.lesson, { skill: f.skill })
      return !!f
    }),
    pacing: () => ({ pace: 1, offerEarly: false }),
    foreground: vi.fn(async () => window),
    idleSeconds: vi.fn(() => 0),
    show: vi.fn(),
    say: vi.fn(),
    log: vi.fn(),
    handled: HANDLED
  }
  const learning = createLearning(deps)
  return { registry, store, runner, teach, deps, learning }
}

function complete(store: ProgressStore, id: string): void {
  const p = store.get()
  p.lessons[id] = {
    completedAt: [Date.now()],
    bestTimeSec: 60,
    hintsUsed: 0,
    doItForMeCount: 0,
    skipped: 0
  }
  p.srs[id] = sm2(undefined, 5, Date.now())
}

describe('learning phrases', () => {
  it('match whole utterances only', () => {
    expect(matchLearnNext('What should I learn next in Blender?')).toEqual({ app: 'blender' })
    expect(matchLearnNext('what should I learn next')).toEqual({})
    expect(matchLearnNext("what's my next lesson")).toEqual({})
    expect(matchLearnNext('what should I eat next')).toBeNull()
    expect(matchStartIt('Start it.')).toBe(true)
    expect(matchStartIt('review')).toBe(true)
    expect(matchStartIt('start the engine')).toBe(false)
    expect(matchStopReminding('stop reminding me')).toBe(true)
    expect(matchStopReminding("don't remind me about reviews")).toBe(true)
    expect(matchStopReminding('remind me tomorrow')).toBe(false)
    expect(matchCoach('coach mode on')).toBe(true)
    expect(matchCoach('stop coaching')).toBe(false)
    expect(matchCoach('coach')).toBeNull()
  })
})

describe('what should I learn next (T28)', () => {
  it('names the next unlocked lesson and "start it" starts it', () => {
    const t = setup()
    complete(t.store, BLENDER_1)
    const r = t.learning.intercept('What should I learn next in Blender?') as { text: string }
    const title = t.registry.lesson(BLENDER_2)!.lesson.title
    expect(r.text).toBe(`Next in Blender: ${title}. Say “start it” to begin.`)
    expect(t.deps.say).toHaveBeenCalledWith(r.text)
    expect(t.learning.intercept('start it')).toBe(HANDLED)
    expect(t.deps.startLesson).toHaveBeenCalledWith(BLENDER_2)
  })

  it('without an app name: the app learned last', () => {
    const t = setup()
    complete(t.store, BLENDER_1)
    const r = t.learning.intercept('what should I learn next') as { text: string }
    expect(r.text).toContain('Next in Blender')
  })

  it('asks for the app when nothing was learned yet', () => {
    const t = setup()
    const r = t.learning.intercept('what should I learn next') as { text: string }
    expect(r.text).toMatch(/^Which app/)
  })

  it('a finished lesson suggests the next one in the bar', async () => {
    const t = setup()
    t.deps.startLesson(BLENDER_1)
    complete(t.store, BLENDER_1)
    t.learning.onLessonDone(BLENDER_1, true)
    await vi.advanceTimersByTimeAsync(NEXT_OFFER_DELAY_MS)
    // The lesson is still in its intro, so the line waits.
    expect(t.deps.show).not.toHaveBeenCalled()
    t.runner.command('stop')
    t.learning.onLessonDone(BLENDER_1, true)
    await vi.advanceTimersByTimeAsync(NEXT_OFFER_DELAY_MS)
    expect(t.deps.show).toHaveBeenCalledWith(BLENDER_2, expect.stringContaining('Next in Blender'))
  })
})

describe('reviews (T29)', () => {
  it('review needs a completed lesson; starts a short review run', () => {
    const t = setup()
    expect(t.learning.startReview(BLENDER_1).ok).toBe(false)
    complete(t.store, BLENDER_1)
    expect(t.learning.startReview(BLENDER_1)).toEqual({ ok: true })
    expect(t.runner.state.review).toBe(true)
    expect(t.runner.state.lesson?.title).toMatch(/^Review: /)
    expect(t.runner.state.lesson!.steps.length).toBeLessThanOrEqual(3)
  })

  it('prompts once a day when the app is in front and a review is due', async () => {
    const t = setup({ process: 'blender.exe', title: 'Blender' })
    complete(t.store, BLENDER_1)
    t.learning.install()
    await vi.advanceTimersByTimeAsync(REMINDER_POLL_MS)
    expect(t.deps.show).not.toHaveBeenCalled() // due tomorrow
    vi.setSystemTime(new Date(2026, 9, 2, 10))
    await vi.advanceTimersByTimeAsync(REMINDER_POLL_MS)
    expect(t.deps.show).toHaveBeenCalledTimes(1)
    expect(t.deps.show).toHaveBeenCalledWith(
      BLENDER_1,
      expect.stringContaining('Quick Blender review')
    )
    await vi.advanceTimersByTimeAsync(REMINDER_POLL_MS * 4)
    expect(t.deps.show).toHaveBeenCalledTimes(1)
    // "not now" dismisses it.
    expect(t.learning.intercept('not now')).toBe(HANDLED)
    expect(t.learning.suggestion()).toBeNull()
    t.learning.stop()
  })

  it('no window reads while no review is due, and none once reminders are off', async () => {
    const t = setup({ process: 'blender.exe', title: 'Blender' })
    t.learning.install()
    await vi.advanceTimersByTimeAsync(REMINDER_POLL_MS * 3)
    expect(t.deps.foreground).not.toHaveBeenCalled()
    complete(t.store, BLENDER_1)
    vi.setSystemTime(new Date(2026, 9, 2, 10))
    const r = t.learning.intercept('stop reminding me') as { text: string }
    expect(r.text).toMatch(/no more review reminders/)
    expect(t.deps.setReminders).toHaveBeenCalledWith(false)
    await vi.advanceTimersByTimeAsync(REMINDER_POLL_MS * 3)
    expect(t.deps.foreground).not.toHaveBeenCalled()
    t.learning.stop()
  })

  it('"review" after the prompt starts the review', async () => {
    const t = setup({ process: 'blender.exe', title: 'Blender' })
    complete(t.store, BLENDER_1)
    vi.setSystemTime(new Date(2026, 9, 3, 10))
    await t.learning.checkReminder()
    expect(t.learning.intercept('review')).toBe(HANDLED)
    expect(t.runner.state.review).toBe(true)
  })
})

describe('coach mode (T33)', () => {
  it('needs idle hints on', () => {
    const t = setup()
    const r = t.learning.intercept('coach mode on') as { text: string }
    expect(r.text).toMatch(/needs idle hints/)
    expect(t.learning.coachMode()).toBe(false)
  })

  it('on: idle in the app brings a caption-only tip, no window read before idle', async () => {
    const t = setup({ process: 'blender.exe', title: 'Blender' })
    t.teach.idleHint = true
    t.learning.intercept('coach mode on')
    expect(t.learning.watcher.watching()).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(t.deps.foreground).not.toHaveBeenCalled()
    t.deps.idleSeconds.mockReturnValue(25)
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.deps.show).toHaveBeenCalledWith(BLENDER_1, expect.stringMatching(/^Stuck in Blender/))
    expect(t.deps.say).not.toHaveBeenCalled()
    t.learning.intercept('coach mode off')
    expect(t.learning.watcher.watching()).toBe(false)
  })
})
