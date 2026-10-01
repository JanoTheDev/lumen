import { describe, expect, it } from 'vitest'
import { ADVANCE_MS, accepts, reduce } from '../../src/main/teach/engine'
import { LEVEL, OFFER_ACTION_ID } from '../../src/main/teach/hints'
import {
  IDLE,
  type LessonEffect,
  type LessonEvent,
  type LessonState
} from '../../src/main/teach/state'
import { LESSON } from './fixtures'

function drive(
  events: LessonEvent[],
  from: LessonState = IDLE
): {
  state: LessonState
  effects: LessonEffect[]
} {
  let state = from
  let effects: LessonEffect[] = []
  for (const e of events) {
    const t = reduce(state, e)
    state = t.state
    effects = t.effects
  }
  return { state, effects }
}

const says = (fx: LessonEffect[]): string[] => fx.flatMap((f) => (f.type === 'say' ? [f.text] : []))
const has = (fx: LessonEffect[], type: LessonEffect['type']): boolean =>
  fx.some((f) => f.type === type)

const start: LessonEvent = { type: 'start', lesson: LESSON }
const next: LessonEvent = { type: 'command', command: 'next' }
const pass = (step: number): LessonEvent => ({ type: 'check', step, result: 'pass' })
const advance: LessonEvent = { type: 'timer', id: 'advance' }

describe('lesson reducer', () => {
  it('starts with an intro and waits for "next"', () => {
    const { state, effects } = drive([start])
    expect(state.phase).toBe('intro')
    expect(says(effects)[0]).toMatch(/Three steps\. About 3 minutes\. Say next/)
    const t = drive([start, next])
    expect(t.state.phase).toBe('step.waiting')
    expect(t.state.index).toBe(0)
    expect(t.state.level).toBe(LEVEL.POINT)
    expect(says(t.effects)).toEqual(['Open the File menu.'])
    expect(t.effects).toContainEqual({ type: 'startChecks', step: 0 })
    expect(t.effects).toContainEqual({ type: 'point', step: 0, level: LEVEL.POINT })
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'hint', ms: 20_000 })
    expect(t.effects).toContainEqual({ type: 'event', name: 'step-started', step: 0 })
  })

  it('autoStart skips the intro', () => {
    const { state } = drive([{ ...start, autoStart: true }])
    expect(state.phase).toBe('step.waiting')
  })

  it('a passing check ticks, praises and moves on after the success tick', () => {
    let t = drive([start, next, pass(0)])
    expect(t.state.phase).toBe('step.passed')
    expect(t.effects).toContainEqual({ type: 'scene', scene: 'success' })
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'advance', ms: ADVANCE_MS })
    expect(t.effects).toContainEqual({ type: 'event', name: 'step-completed', step: 0 })
    expect(has(t.effects, 'persist')).toBe(true)
    t = drive([advance], t.state)
    expect(t.state.index).toBe(1)
    expect(t.state.phase).toBe('step.waiting')
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'timeout', ms: 30_000 })
  })

  it('runs the whole lesson to done', () => {
    const t = drive([
      start,
      next,
      pass(0),
      advance,
      pass(1),
      advance,
      { type: 'command', command: 'done' },
      { type: 'check', step: 2, result: 'pass', forced: true },
      advance
    ])
    expect(t.state.phase).toBe('done')
    expect(says(t.effects)[0]).toMatch(/end of Three steps/)
    expect(t.effects).toContainEqual({ type: 'event', name: 'done', step: 2, completed: true })
    expect(t.effects).toContainEqual({ type: 'scene', scene: 'clear' })
  })

  it('ignores a pass for another step', () => {
    const t = drive([start, next, pass(1)])
    expect(t.state.phase).toBe('step.waiting')
  })

  it('escalates the hint ladder to the level 4 offer, then does it on yes', () => {
    const hint: LessonEvent = { type: 'timer', id: 'hint' }
    let t = drive([start, next, hint])
    expect(t.state.level).toBe(LEVEL.HINT)
    expect(says(t.effects)).toEqual(['File is top left.'])
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'hint', ms: 20_000 })
    t = drive([hint], t.state)
    expect(t.state.level).toBe(LEVEL.RING)
    expect(says(t.effects)).toEqual(['Press Alt then F.'])
    expect(t.effects).toContainEqual({ type: 'point', step: 0, level: LEVEL.RING })
    t = drive([hint], t.state)
    expect(t.state.level).toBe(LEVEL.OFFER)
    expect(t.state.phase).toBe('offer-do-it')
    const assistant = t.effects.find((f) => f.type === 'assistant')
    expect(assistant).toMatchObject({
      state: { phase: 'confirm', confirm: { actionId: OFFER_ACTION_ID, risk: 'low' } }
    })
    expect(t.state.stats.open.hints).toBe(3)
    t = drive([{ type: 'command', command: 'yes' }], t.state)
    expect(t.state.phase).toBe('doing-it')
    expect(t.effects).toContainEqual({ type: 'exec', step: 0 })
    t = drive([{ type: 'do-it-done', step: 0, ok: true, said: 'I clicked File for you.' }], t.state)
    expect(t.state.phase).toBe('step.passed')
    expect(says(t.effects)).toEqual(['I clicked File for you.'])
    expect(t.state.stats.open.doItForMe).toBe(true)
  })

  it('"help" jumps one hint level; "do it for me" skips the offer', () => {
    let t = drive([start, next, { type: 'command', command: 'help' }])
    expect(t.state.level).toBe(LEVEL.HINT)
    t = drive([{ type: 'command', command: 'do-it' }], t.state)
    expect(t.state.phase).toBe('doing-it')
    t = drive([{ type: 'do-it-done', step: 0, ok: false }], t.state)
    expect(t.state.phase).toBe('step.waiting')
    expect(says(t.effects)[0]).toMatch(/^I couldn't do that one\./)
  })

  it('idle hints switched off mid-lesson bring the timer ladder back (review teach #5)', () => {
    let t = drive([{ type: 'start', lesson: LESSON, idleHints: true }, next])
    expect(t.effects.some((f) => f.type === 'startTimer' && f.id === 'hint')).toBe(false)
    t = drive([{ type: 'idle-hints-off' }], t.state)
    expect(t.state.idleHints).toBe(false)
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'hint', ms: 20_000 })
    expect(drive([{ type: 'idle-hints-off' }], t.state).effects).toEqual([])
  })

  it('an untrusted lesson never offers or runs do-it (review teach #2)', () => {
    const lesson = { ...LESSON, steps: LESSON.steps.map((st) => ({ ...st, noDoIt: true })) }
    const hint: LessonEvent = { type: 'timer', id: 'hint' }
    let t = drive([{ type: 'start', lesson }, next, hint, hint])
    expect(t.state.level).toBe(LEVEL.RING)
    t = drive([hint], t.state)
    expect(t.state.phase).toBe('step.waiting')
    expect(t.state.level).toBe(LEVEL.RING)
    expect(t.effects).toEqual([])
    t = drive([{ type: 'timer', id: 'timeout' }], t.state)
    expect(t.state.phase).toBe('step.waiting')
    t = drive([{ type: 'command', command: 'do-it' }], t.state)
    expect(t.state.phase).toBe('step.waiting')
    expect(has(t.effects, 'exec')).toBe(false)
    expect(says(t.effects)[0]).toMatch(/can’t do steps from this lesson/)
    // "click it" is the user's explicit request and still works.
    t = drive([{ type: 'command', command: 'perform' }], t.state)
    expect(t.effects).toContainEqual({ type: 'exec', step: 0, perform: true })
  })

  it('"no" to the offer goes back to waiting, checks still pass the step', () => {
    let t = drive([start, next, { type: 'timer', id: 'timeout' }])
    expect(t.state.phase).toBe('offer-do-it')
    t = drive([{ type: 'command', command: 'no' }], t.state)
    expect(t.state.phase).toBe('step.waiting')
    t = drive([pass(0)], t.state)
    expect(t.state.phase).toBe('step.passed')
  })

  it('a step timeout offers do-it without failing', () => {
    let t = drive([start, next, pass(0), advance])
    expect(t.state.level).toBe(LEVEL.POINT)
    t = drive([{ type: 'timer', id: 'timeout' }], t.state)
    expect(t.state.phase).toBe('offer-do-it')
    expect(t.state.index).toBe(1)
  })

  it('pauses and resumes on the same step', () => {
    let t = drive([start, next, pass(0), advance, { type: 'command', command: 'pause' }])
    expect(t.state.phase).toBe('paused')
    expect(t.effects).toContainEqual({ type: 'cancelChecks' })
    expect(t.effects).toContainEqual({ type: 'scene', scene: 'clear' })
    expect(has(t.effects, 'persist')).toBe(true)
    // Timers that fire late do nothing while paused.
    expect(drive([{ type: 'timer', id: 'hint' }], t.state).state.phase).toBe('paused')
    expect(accepts(t.state, 'help')).toBe(false)
    t = drive([{ type: 'command', command: 'resume' }], t.state)
    expect(t.state.phase).toBe('step.waiting')
    expect(t.state.index).toBe(1)
    expect(says(t.effects)).toEqual(['Press Control S to save.'])
  })

  it('pauses when the app is away for a minute', () => {
    const t = drive([start, next, { type: 'app-blur' }])
    expect(t.state.phase).toBe('paused')
  })

  it('back and skip move between steps; skip records it', () => {
    let t = drive([start, next, { type: 'command', command: 'skip' }])
    expect(t.state.index).toBe(1)
    expect(t.state.stats.open.skipped).toBe(true)
    t = drive([{ type: 'command', command: 'back' }], t.state)
    expect(t.state.index).toBe(0)
    t = drive([{ type: 'command', command: 'back' }], t.state)
    expect(t.state.index).toBe(0)
    t = drive(
      [
        { type: 'command', command: 'skip' },
        { type: 'command', command: 'skip' },
        { type: 'command', command: 'skip' }
      ],
      t.state
    )
    expect(t.state.phase).toBe('done')
  })

  it('"done" evaluates now: fail says the next hint, unknown asks', () => {
    let t = drive([start, next, { type: 'command', command: 'done' }])
    expect(t.state.phase).toBe('step.checking')
    expect(t.effects).toContainEqual({ type: 'evaluate', step: 0 })
    const failed = drive([{ type: 'check', step: 0, result: 'fail', forced: true }], t.state)
    expect(failed.state.phase).toBe('step.waiting')
    expect(says(failed.effects)).toEqual(['Not quite yet. File is top left.'])
    expect(failed.state.stats.open.attempts).toBe(1)
    t = drive([{ type: 'check', step: 0, result: 'unknown', forced: true }], t.state)
    expect(t.state.phase).toBe('ask-worked')
    expect(drive([{ type: 'command', command: 'yes' }], t.state).state.phase).toBe('step.passed')
    expect(drive([{ type: 'command', command: 'no' }], t.state).state.phase).toBe('step.waiting')
  })

  it('repeat and why speak without changing state', () => {
    const base = drive([start, next]).state
    const r = drive([{ type: 'command', command: 'repeat' }], base)
    expect(r.state).toEqual(base)
    expect(says(r.effects)).toEqual(['Open the File menu.'])
    const w = drive([{ type: 'command', command: 'why' }], base)
    expect(says(w.effects)).toEqual(['Menus hold the commands.'])
    expect(w.state).toEqual(base)
    // No why in the lesson: the runner asks the model.
    const last = drive(
      [
        { type: 'command', command: 'skip' },
        { type: 'command', command: 'skip' }
      ],
      base
    )
    expect(drive([{ type: 'command', command: 'why' }], last.state).effects).toEqual([
      { type: 'explain', step: 2 }
    ])
  })

  it('slower doubles the gaps between hints', () => {
    let t = drive([start, next, { type: 'command', command: 'slower' }])
    expect(t.state.pace).toBe(1.5)
    t = drive([{ type: 'command', command: 'slower' }], t.state)
    expect(t.state.pace).toBe(2)
    expect(t.effects).toContainEqual({ type: 'startTimer', id: 'hint', ms: 40_000 })
    t = drive([{ type: 'command', command: 'faster' }], t.state)
    expect(t.state.pace).toBe(1.5)
  })

  it('stop aborts and persists so the lesson can be resumed', () => {
    const t = drive([start, next, { type: 'command', command: 'stop' }])
    expect(t.state.phase).toBe('aborted')
    expect(t.effects).toContainEqual({ type: 'event', name: 'done', step: 0, completed: false })
    expect(has(t.effects, 'persist')).toBe(true)
    expect(accepts(t.state, 'next')).toBe(false)
  })

  it('resuming at a step skips the intro and keeps stats', () => {
    const stats = { open: { attempts: 2, hints: 1, skipped: false, doItForMe: false } }
    const t = drive([{ ...start, stepIndex: 2, stats }])
    expect(t.state.phase).toBe('step.waiting')
    expect(t.state.index).toBe(2)
    expect(t.state.stats.open.attempts).toBe(2)
    expect(t.state.level).toBe(LEVEL.SAY)
  })

  it('yes / no / resume only count where they mean something', () => {
    const waiting = drive([start, next]).state
    expect(accepts(waiting, 'yes')).toBe(false)
    expect(accepts(waiting, 'resume')).toBe(false)
    expect(accepts(waiting, 'next')).toBe(true)
    expect(accepts(IDLE, 'next')).toBe(false)
  })
})
