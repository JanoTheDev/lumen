import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reduce } from '../../src/main/teach/engine'
import { LEVEL } from '../../src/main/teach/hints'
import {
  IDLE_POLL_MS,
  IdleHintWatcher,
  type IdleHintConfig,
  type IdleHintDeps,
  type IdleLesson
} from '../../src/main/teach/idle-hint'
import { IDLE } from '../../src/main/teach/state'
import { LESSON } from './fixtures'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

type Fn = ReturnType<typeof vi.fn>
interface Fake {
  cfg: IdleHintConfig
  st: { idle: number; lesson: IdleLesson | null; coach: boolean; front: string | null }
  deps: IdleHintDeps & {
    idleSeconds: Fn
    foregroundApp: Fn
    lessonHint: Fn
    coachHint: Fn
    log: Fn
  }
  w: IdleHintWatcher
}

function setup(over: Partial<IdleHintConfig> = {}): Fake {
  const cfg: IdleHintConfig = { enabled: true, apps: [], seconds: 20, voice: false, ...over }
  const st = {
    idle: 0,
    lesson: null as IdleLesson | null,
    coach: false,
    front: 'fake' as string | null
  }
  const deps = {
    config: () => cfg,
    idleSeconds: vi.fn(() => st.idle),
    lesson: () => st.lesson,
    coach: () => st.coach,
    foregroundApp: vi.fn(async () => st.front),
    lessonHint: vi.fn(() => true),
    coachHint: vi.fn(),
    log: vi.fn()
  } satisfies IdleHintDeps
  return { cfg, st, deps, w: new IdleHintWatcher(deps) }
}

const lesson = (key = 'l#0'): IdleLesson => ({ key, appId: 'fake', waiting: true, anyApp: false })

describe('IdleHintWatcher', () => {
  it('off: no watcher, no idle reads, no window reads', async () => {
    const { st, deps, w } = setup({ enabled: false })
    st.lesson = lesson()
    st.idle = 999
    w.sync()
    expect(w.watching()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.idleSeconds).not.toHaveBeenCalled()
    expect(deps.foregroundApp).not.toHaveBeenCalled()
    expect(deps.lessonHint).not.toHaveBeenCalled()
  })

  it('on but no lesson and no coach mode: not watching', () => {
    const { w } = setup()
    w.sync()
    expect(w.watching()).toBe(false)
  })

  it('a hint after N idle seconds with the lesson app in front, then every N more', async () => {
    const { st, deps, w } = setup({ voice: true })
    st.lesson = lesson()
    w.sync()
    expect(w.watching()).toBe(true)
    st.idle = 19
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).not.toHaveBeenCalled()
    expect(deps.foregroundApp).not.toHaveBeenCalled()
    st.idle = 21
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).toHaveBeenCalledWith(true)
    st.idle = 30
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).toHaveBeenCalledTimes(1)
    st.idle = 41
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).toHaveBeenCalledTimes(2)
    // Input resets the stretch.
    st.idle = 1
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    st.idle = 21
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).toHaveBeenCalledTimes(3)
  })

  it('no hint while another app is in front, or for an app it is off for', async () => {
    const { st, deps, w, cfg } = setup()
    st.lesson = lesson()
    st.front = 'other'
    st.idle = 25
    w.sync()
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).not.toHaveBeenCalled()
    st.front = 'fake'
    cfg.apps = ['blender']
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(deps.lessonHint).not.toHaveBeenCalled()
  })

  it('coach mode: one nudge per idle stretch for the app in front', async () => {
    const { st, deps, w } = setup()
    st.coach = true
    w.sync()
    st.idle = 25
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 5)
    expect(deps.coachHint).toHaveBeenCalledTimes(1)
    expect(deps.coachHint).toHaveBeenCalledWith('fake', false)
  })

  it('stops itself when turned off', async () => {
    const { st, w, cfg, deps } = setup()
    st.lesson = lesson()
    w.sync()
    cfg.enabled = false
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(w.watching()).toBe(false)
    expect(deps.log).toHaveBeenCalledWith('idle hints: stopped')
  })
})

describe('engine with idle hints', () => {
  it('no ladder timer; an idle event gives the next hint quietly (bar only)', () => {
    const t = reduce(IDLE, { type: 'start', lesson: LESSON, autoStart: true, idleHints: true })
    expect(t.effects.some((e) => e.type === 'startTimer' && e.id === 'hint')).toBe(false)
    const quiet = reduce(t.state, { type: 'idle', voice: false })
    expect(quiet.state.level).toBe(LEVEL.HINT)
    expect(quiet.effects.some((e) => e.type === 'say')).toBe(false)
    expect(quiet.effects).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        state: expect.objectContaining({ statusText: 'File is top left.' })
      })
    )
    const spoken = reduce(quiet.state, { type: 'idle', voice: true })
    expect(spoken.effects).toContainEqual({
      type: 'say',
      text: 'Press Alt then F.',
      interruptible: true
    })
  })

  it('idle reaches the do-it offer without speaking it', () => {
    let s = reduce(IDLE, { type: 'start', lesson: LESSON, autoStart: true, idleHints: true }).state
    s = reduce(s, { type: 'idle', voice: false }).state
    s = reduce(s, { type: 'idle', voice: false }).state
    const t = reduce(s, { type: 'idle', voice: false })
    expect(t.state.phase).toBe('offer-do-it')
    expect(t.effects.some((e) => e.type === 'say')).toBe(false)
  })

  it('idle does nothing outside a waiting step', () => {
    const s = reduce(IDLE, { type: 'start', lesson: LESSON }).state
    expect(s.phase).toBe('intro')
    expect(reduce(s, { type: 'idle', voice: true }).effects).toEqual([])
  })
})
