import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantState } from '@shared/events'
import { LEVEL, pacingFor } from '../../src/main/teach/hints'
import { noopPorts, type LessonScene, type Ports, type UiaEvent } from '../../src/main/teach/ports'
import { DO_IT_CONFIRM_MS, LessonRunner } from '../../src/main/teach/runner'
import { LESSON } from './fixtures'

const RECT = { x: 400, y: 300, w: 80, h: 30 }

function setup(over: Partial<Ports> = {}): {
  runner: LessonRunner
  scenes: (LessonScene | null)[]
  states: (AssistantState | null)[]
  said: string[]
  exec: ReturnType<typeof vi.fn>
  emitUia(e: UiaEvent): void
  saves: number
} {
  const scenes: (LessonScene | null)[] = []
  const states: (AssistantState | null)[] = []
  const said: string[] = []
  const subs = new Set<(e: UiaEvent) => void>()
  const exec = vi.fn(async () => true)
  const out = {
    scenes,
    states,
    said,
    exec,
    saves: 0,
    emitUia: (e: UiaEvent) => subs.forEach((s) => s(e)),
    runner: null as unknown as LessonRunner
  }
  const ports = noopPorts({
    screen: {
      capture: async () => null,
      diff: () => null,
      emitScene: (s) => scenes.push(s),
      emitState: (s) => states.push(s)
    },
    target: {
      resolveTarget: async (t) =>
        'shortcut' in t
          ? { point: { x: 960, y: 540 }, source: 'shortcut' }
          : { rect: RECT, point: { x: 440, y: 315 }, source: 'element' }
    },
    uia: {
      find: async () => [],
      subscribe: (_k, cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      }
    },
    exec: { run: exec },
    speak: { say: (t) => said.push(t) },
    ...over
  })
  out.runner = new LessonRunner(ports, { progress: { save: () => out.saves++ } })
  return out
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0)

describe('LessonRunner scene and state output (hint ladder)', () => {
  it('walks L0 → L4, then does the step and moves on', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    // L0 + L1: step text in the bar, buddy flies to the target.
    expect(t.states.at(-1)).toMatchObject({
      phase: 'waiting-user',
      statusText: 'Open the File menu.',
      step: { index: 1, total: 3 }
    })
    expect(t.scenes.at(-1)).toEqual({
      highlights: [],
      buddy: { to: { x: 440, y: 315 }, mode: 'fly' },
      dwellSnap: RECT
    })
    expect(t.said).toEqual(['Open the File menu.'])

    // L2 at 20 s: hint[0], buddy points again.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.said.at(-1)).toBe('File is top left.')
    expect(t.scenes.at(-1)?.buddy?.mode).toBe('point')
    expect(t.scenes.at(-1)?.highlights).toEqual([])

    // L3 at 40 s: ring + arrow + hint[1].
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.said.at(-1)).toBe('Press Alt then F.')
    const ring = t.scenes.at(-1)!
    expect(ring.highlights).toEqual([{ id: 'lesson-target', rect: RECT, style: 'ring' }])
    expect(ring.annotations?.[0].kind).toBe('arrow')
    expect(ring.annotations?.[0].points[1].x).toBeLessThan(RECT.x)

    // L4 at 60 s: confirm offer.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.runner.state.phase).toBe('offer-do-it')
    expect(t.states.at(-1)?.phase).toBe('confirm')
    expect(t.exec).not.toHaveBeenCalled()

    // L5: yes → run, checks get a moment, then the success tick.
    expect(t.runner.command('yes')).toBe(true)
    await flush()
    expect(t.exec).toHaveBeenCalledWith(
      [{ t: 'invoke', element: { name: 'File', role: 'menuitem' } }],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    t.emitUia({ kind: 'invoked', element: { name: 'File' } })
    await flush()
    expect(t.runner.state.phase).toBe('step.passed')
    expect(t.said.at(-1)).toBe('I clicked File for you.')
    expect(t.scenes.at(-1)?.highlights[0]).toMatchObject({ style: 'success', rect: RECT })

    await vi.advanceTimersByTimeAsync(600)
    expect(t.runner.state.index).toBe(1)
    // Shortcut step: key-cap label by the buddy, no ring.
    expect(t.scenes.at(-1)).toEqual({
      highlights: [],
      buddy: { to: { x: 960, y: 540 }, label: 'Ctrl+S', mode: 'wait' }
    })
  })

  it('trusts a do-it run when the check cannot tell', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.runner.command('do-it')
    await vi.advanceTimersByTimeAsync(DO_IT_CONFIRM_MS + 10)
    expect(t.runner.state.phase).toBe('step.passed')
    expect(t.runner.state.stats.open.doItForMe).toBe(true)
  })

  it('a failed run says so and keeps waiting', async () => {
    const t = setup({ exec: { run: async () => false } })
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.runner.command('do-it')
    await flush()
    expect(t.runner.state.phase).toBe('step.waiting')
    expect(t.said.at(-1)).toMatch(/couldn't do that one/)
  })

  it('a matching UIA event passes the step on its own', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.emitUia({ kind: 'invoked', element: { name: 'Edit' } })
    await flush()
    expect(t.runner.state.phase).toBe('step.waiting')
    t.emitUia({ kind: 'invoked', element: { name: 'File' } })
    await flush()
    expect(t.runner.state.phase).toBe('step.passed')
    expect(t.saves).toBeGreaterThan(1)
  })

  it('hint timers wait while Lumen speaks or the user talks', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.runner.hold('speaking', true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.runner.state.level).toBe(LEVEL.POINT)
    t.runner.hold('speaking', false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.runner.state.level).toBe(LEVEL.HINT)
  })

  it('clears the scene and hands the bar back on stop', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.runner.command('stop')
    expect(t.scenes.at(-1)).toBeNull()
    expect(t.states.at(-1)).toBeNull()
    expect(t.runner.running()).toBe(false)
    expect(t.runner.context()).toBeNull()
  })

  it('exposes the lesson context for normal queries', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    expect(t.runner.context()).toEqual({
      app: 'fake',
      lessonTitle: 'Three steps',
      stepSay: 'Open the File menu.'
    })
  })

  it('a target lookup that finishes after the step changed draws nothing', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => (release = r))
    const t = setup({
      target: {
        resolveTarget: async () => {
          await slow
          return { rect: RECT, point: { x: 1, y: 1 }, source: 'element' }
        }
      }
    })
    t.runner.start(LESSON, { autoStart: true })
    t.runner.command('skip')
    const before = t.scenes.length
    release()
    await flush()
    // Only the second step's scene lands.
    expect(t.scenes.slice(before).every((s) => s?.buddy?.label === 'Ctrl+S')).toBe(true)
  })
})

describe('LessonRunner "why?" (T20)', () => {
  it('says the step why without touching the check', async () => {
    const why = vi.fn(async () => 'never')
    const t = setup({ explain: { why } })
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    t.runner.command('why')
    expect(t.said.at(-1)).toBe('Menus hold the commands.')
    expect(t.states.at(-1)?.statusText).toBe('Menus hold the commands.')
    expect(why).not.toHaveBeenCalled()
    expect(t.runner.state.phase).toBe('step.waiting')
  })

  it('asks the model when the step has no why, keeps two sentences and caches it', async () => {
    const why = vi.fn(async () => 'Saving writes the file. It keeps your work safe. And more.')
    const t = setup({ explain: { why } })
    t.runner.start(LESSON, { autoStart: true, stepIndex: 2 })
    await flush()
    t.runner.command('why')
    await flush()
    expect(t.said.at(-1)).toBe('Saving writes the file. It keeps your work safe.')
    t.runner.command('why')
    await flush()
    expect(why).toHaveBeenCalledTimes(1)
    expect(t.runner.state.phase).toBe('step.waiting')
  })

  it('falls back to a plain sentence when no model answers', async () => {
    const t = setup({ explain: { why: async () => null } })
    t.runner.start(LESSON, { autoStart: true, stepIndex: 2 })
    await flush()
    t.runner.command('why')
    await flush()
    expect(t.said.at(-1)).toBe('This step is part of Three steps.')
  })
})

describe('accessible pacing (T21)', () => {
  it('"click it" invokes the target without counting as do-it-for-me', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true })
    await flush()
    expect(t.runner.command('perform')).toBe(true)
    await flush()
    expect(t.exec).toHaveBeenCalledWith(
      [{ t: 'invoke', element: { name: 'File', role: 'menuitem' } }],
      expect.anything()
    )
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.runner.state.phase).toBe('step.passed')
    expect(t.said.at(-1)).not.toMatch(/for you/)
    expect(t.runner.state.stats.open.doItForMe).toBe(false)
  })

  it('"press it" sends shortcut keys; steps without a target refuse it', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true, stepIndex: 1 })
    await flush()
    t.runner.command('perform')
    await flush()
    expect(t.exec).toHaveBeenCalledWith([{ t: 'keys', combo: 'Ctrl+S' }], expect.anything())
    const u = setup()
    u.runner.start(LESSON, { autoStart: true, stepIndex: 2 })
    expect(u.runner.command('perform')).toBe(false)
  })

  it('offers "do it" from the first level for voice-only and switch users', async () => {
    const t = setup()
    t.runner.start(LESSON, { autoStart: true, offerEarly: true })
    await flush()
    expect(t.states.at(-1)?.statusText).toBe('Open the File menu. Say “do it” and I will.')
    // The caption keeps the step text: the spoken text does not change.
    expect(t.said).toEqual(['Open the File menu.'])
    const plain = setup()
    plain.runner.start(LESSON, { autoStart: true })
    expect(plain.states.at(-1)?.statusText).toBe('Open the File menu.')
  })

  it('pacing follows the a11y config', () => {
    expect(pacingFor({})).toEqual({ pace: 1, offerEarly: false })
    expect(pacingFor({ timings: { statusHoldMs: 12_000 } }).pace).toBe(2)
    expect(pacingFor({ profiles: ['cognitive'] }).pace).toBe(1.5)
    expect(pacingFor({ profiles: ['motor-voice'] }).offerEarly).toBe(true)
    expect(pacingFor({ switch: { enabled: true } }).offerEarly).toBe(true)
    expect(pacingFor({ profiles: ['eye-gaze'] }).offerEarly).toBe(false)
  })
})
