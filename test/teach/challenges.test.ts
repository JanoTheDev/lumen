import { describe, expect, it, vi } from 'vitest'
import {
  appMastery,
  levelFor,
  parseChallengeCommand,
  streak,
  toChallenge,
  verdict,
  weakSkills,
  type ChallengeData,
  type ChallengeRecord
} from '../../src/main/teach/challenges'
import { ChallengeRunner, type ChallengeDeps } from '../../src/main/teach/challenge-run'

const DAY = 24 * 60 * 60 * 1000
const noon = new Date(2026, 9, 1, 12).getTime()

const rec = (finishedAt: number, passed = true): ChallengeRecord => ({
  id: `c${finishedAt}`,
  app: 'blender',
  title: 'Mug',
  level: 'beginner',
  startedAt: finishedAt - 60_000,
  finishedAt,
  passed,
  met: 3,
  total: 3,
  overTime: false,
  feedback: ''
})

const GEN = {
  title: 'Coffee mug',
  goal: 'Model a coffee mug with a handle.',
  setup: 'Start a new file.',
  minutes: 10,
  skills: ['Modeling', 'extrude'],
  rubric: ['A cylinder shape is in the scene', 'It is hollow', 'It has a handle']
}

describe('challenges (pure)', () => {
  it('streak counts days in a row ending today or yesterday', () => {
    const h = [rec(noon - 3 * DAY), rec(noon - 2 * DAY), rec(noon - DAY), rec(noon - DAY + 1000)]
    expect(streak(h, noon)).toEqual({ current: 3, best: 3 })
    expect(streak(h, noon + 2 * DAY)).toEqual({ current: 0, best: 3 })
    expect(streak([rec(noon, false)], noon)).toEqual({ current: 0, best: 0 })
  })

  it('level from mastery, harder / easier from the last one', () => {
    expect(levelFor(null)).toBe('beginner')
    expect(levelFor(0.6)).toBe('intermediate')
    expect(levelFor(0.9)).toBe('advanced')
    expect(levelFor(0.9, 'beginner')).toBe('beginner')
    expect(levelFor(0.2, 'harder', 'intermediate')).toBe('advanced')
    expect(levelFor(0.2, 'easier')).toBe('beginner')
  })

  it('mastery per app and its weakest skills', () => {
    const m = { 'blender:modeling': 0.2, 'blender:render': 0.8, 'gimp:layers': 1 }
    expect(appMastery(m, 'blender')).toBeCloseTo(0.5)
    expect(appMastery(m, 'obs')).toBeNull()
    expect(weakSkills(m, 'blender', 1)).toEqual(['modeling'])
  })

  it('toChallenge cleans the model reply', () => {
    const c = toChallenge(
      { ...GEN, minutes: 99 },
      { app: 'blender', appName: 'Blender', level: 'beginner', now: 5 }
    )!
    expect(c).toMatchObject({ minutes: 30, skills: ['modeling', 'extrude'], rubric: GEN.rubric })
    expect(
      toChallenge({ ...GEN, rubric: ['x'] }, { app: 'a', appName: 'A', level: 'beginner', now: 1 })
    ).toBeNull()
  })

  it('verdict passes at two thirds', () => {
    const c = toChallenge(GEN, { app: 'b', appName: 'B', level: 'beginner', now: 1 })!
    const v = verdict(c, {
      items: [
        { n: 1, met: true, note: '' },
        { n: 2, met: true, note: '' },
        { n: 3, met: false, note: '' }
      ],
      feedback: 'Nice shape. Add a handle with an extruded loop.'
    })
    expect(v).toMatchObject({
      met: 2,
      total: 3,
      passed: true,
      quality: 3,
      missed: ['It has a handle']
    })
  })

  it('voice commands', () => {
    expect(parseChallengeCommand('Give me a challenge', false)).toEqual({ kind: 'start' })
    expect(parseChallengeCommand('give me a harder challenge in blender', false)).toEqual({
      kind: 'start',
      level: 'harder',
      app: 'blender'
    })
    expect(parseChallengeCommand('challenge me', false)).toEqual({ kind: 'start' })
    expect(parseChallengeCommand("what's my streak", false)).toEqual({ kind: 'streak' })
    expect(parseChallengeCommand("I'm done", false)).toBeNull()
    expect(parseChallengeCommand("I'm done", true)).toEqual({ kind: 'check' })
    expect(parseChallengeCommand('check my work', true)).toEqual({ kind: 'check' })
    expect(parseChallengeCommand('give up', true)).toEqual({ kind: 'stop' })
    expect(parseChallengeCommand('how much time is left', true)).toEqual({ kind: 'time' })
  })
})

function setup(over: Partial<ChallengeDeps> = {}): {
  r: ChallengeRunner
  saved: () => ChallengeData
  deps: ChallengeDeps
  timers: (() => void)[]
} {
  let data: ChallengeData = { version: 1, history: [] }
  const timers: (() => void)[] = []
  const deps: ChallengeDeps = {
    now: () => noon,
    foregroundApp: async () => ({ id: 'blender', name: 'Blender' }),
    appByName: (q) => (q === 'gimp' ? { id: 'gimp', name: 'GIMP' } : null),
    learner: () => ({ mastery: null, weak: [], done: [] }),
    readingLevel: () => '',
    generate: vi.fn(async () => GEN),
    capture: async () => ({ data: 'IMG', mime: 'image/jpeg' }),
    appState: async () => '{"object_count":3}',
    judge: vi.fn(async () => ({
      items: [1, 2, 3].map((n) => ({ n, met: true, note: '' })),
      feedback: 'Great mug.'
    })),
    practice: vi.fn(),
    load: () => data,
    save: (d) => (data = d),
    say: vi.fn(),
    showLine: vi.fn(),
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
    log: () => {},
    handled: 'H',
    ...over
  }
  const r = new ChallengeRunner(deps, { generate: 'G', check: 'C' })
  return { r, saved: () => data, deps, timers }
}

describe('ChallengeRunner', () => {
  it('starts, checks, records the pass and the mastery', async () => {
    const { r, saved, deps, timers } = setup()
    const started = (await r.intercept('give me a challenge')) as { text: string }
    expect(started.text).toMatch(/^Coffee mug\. Model a coffee mug/)
    expect(saved().active?.app).toBe('blender')
    timers[0]()
    expect(deps.say).toHaveBeenCalledWith(expect.stringMatching(/^Time is up/))
    const checked = (await r.intercept('check my work')) as { text: string }
    expect(checked.text).toMatch(/^Challenge passed: 3 of 3 checks\. Great mug\./)
    expect(deps.judge).toHaveBeenCalledWith(
      'C',
      expect.stringContaining('app state: {"object_count":3}'),
      { data: 'IMG', mime: 'image/jpeg' }
    )
    expect(deps.practice).toHaveBeenCalledWith('blender', ['modeling', 'extrude'], 5)
    expect(saved().active).toBeUndefined()
    expect(r.status()).toMatchObject({ streak: 1, passed: 1 })
  })

  it('no screen: the bar line goes back to the challenge (review teach #3)', async () => {
    const { r, deps } = setup({ capture: async () => null })
    await r.start()
    vi.mocked(deps.showLine).mockClear()
    expect(await r.check()).toMatchObject({ ok: false })
    expect(vi.mocked(deps.showLine).mock.calls.at(-1)?.[0]).toMatch(/^Challenge: Coffee mug/)
  })

  it('"give up" during a check keeps the challenge stopped (review teach #4)', async () => {
    let release: () => void = () => {}
    const { r, saved } = setup({
      judge: () =>
        new Promise((res) => {
          release = () => res({ items: [{ n: 1, met: false, note: '' }], feedback: 'No.' })
        })
    })
    await r.start()
    const pending = r.check()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.stop()).toBe(true)
    release()
    expect(await pending).toEqual({ ok: false, text: 'The challenge was stopped.' })
    expect(saved().active).toBeUndefined()
  })

  it('a miss keeps the challenge on to try again', async () => {
    const { r, saved } = setup({
      judge: async () => ({ items: [{ n: 1, met: true, note: '' }], feedback: 'Add a handle.' })
    })
    await r.start()
    const out = await r.check()
    expect(out.text).toMatch(/^Not there yet: 1 of 3 checks\. Still missing/)
    expect(saved().active).toBeDefined()
    expect(saved().history).toHaveLength(1)
    expect(r.stop()).toBe(true)
    expect(saved().active).toBeUndefined()
  })

  it('names an app, or says it does not know it', async () => {
    const { r } = setup()
    expect(await r.start({ app: 'gimp' })).toMatchObject({ ok: true })
    r.stop()
    expect(await r.start({ app: 'nope' })).toMatchObject({ ok: false })
  })

  it('check without a challenge, and a model that fails', async () => {
    const { r } = setup({ generate: async () => null })
    expect((await r.check()).ok).toBe(false)
    expect(await r.start()).toMatchObject({ ok: false })
    expect(r.intercept("I'm done")).toBeUndefined()
  })
})
