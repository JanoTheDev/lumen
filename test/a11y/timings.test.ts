import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PausableTimer,
  answerAutoCloseMs,
  captionHoldMs,
  confirmCountdownMs,
  statusHoldMs,
  type TimingConfig
} from '../../src/main/a11y/timings'
import { parseCommand, IDLE_CONTEXT } from '../../src/main/a11y/voice-commands'
import { A11yCommands } from '../../src/main/a11y/dispatch'
import { makeConfig } from '../helpers/fixtures'
import { fakeA11yIo } from '../helpers/fake-a11y-io'

function cfg(t: Partial<TimingConfig['a11y']['timings']> = {}, answer = 10_000): TimingConfig {
  return {
    answerAutoCloseMs: answer,
    a11y: { timings: { statusHoldMs: 4000, captionHoldMs: 0, ...t } }
  }
}

describe('timing helpers', () => {
  it('status lines stay at least statusHoldMs; sticky lines stay sticky', () => {
    expect(statusHoldMs(cfg(), 900)).toBe(4000)
    expect(statusHoldMs(cfg({ statusHoldMs: 8000 }), 5000)).toBe(8000)
    expect(statusHoldMs(cfg(), 12_000)).toBe(12_000)
    expect(statusHoldMs(cfg(), undefined)).toBeUndefined()
    expect(statusHoldMs(cfg(), 0)).toBe(0)
  })

  it('answer auto-close: 0 is never, the factor extends it', () => {
    expect(answerAutoCloseMs(cfg({}, 0), 4)).toBe(0)
    expect(answerAutoCloseMs(cfg({}, 10_000))).toBe(10_000)
    expect(answerAutoCloseMs(cfg({}, 10_000), 2)).toBe(20_000)
    expect(answerAutoCloseMs(cfg({}, 500_000), 4)).toBe(600_000)
  })

  it('confirm countdown: unset keeps the app value, 0 waits, a value wins', () => {
    expect(confirmCountdownMs(cfg(), 3000)).toBe(3000)
    expect(confirmCountdownMs(cfg({ confirmCountdownMs: 0 }), 3000)).toBeUndefined()
    expect(confirmCountdownMs(cfg({ confirmCountdownMs: 9000 }), 3000)).toBe(9000)
  })

  it('caption hold is never negative', () => {
    expect(captionHoldMs(cfg({ captionHoldMs: 5000 }))).toBe(5000)
    expect(captionHoldMs(cfg())).toBe(0)
  })

  it('the default config validates without a confirm countdown', () => {
    const c = makeConfig()
    expect(c.a11y.timings.confirmCountdownMs).toBeUndefined()
    expect(confirmCountdownMs(c, 2000)).toBe(2000)
    const waits = makeConfig({ a11y: { timings: { confirmCountdownMs: 0 } } })
    expect(confirmCountdownMs(waits, 2000)).toBeUndefined()
  })
})

describe('PausableTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const clock = {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
  }

  it('fires once after its time', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock)
    t.start(4000, fn)
    vi.advanceTimersByTime(3999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(t.running).toBe(false)
  })

  it('pauses on hover and resumes with what was left (never under the minimum)', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock, 1500)
    t.start(4000, fn)
    vi.advanceTimersByTime(3000)
    t.pause('hover')
    vi.advanceTimersByTime(60_000)
    expect(fn).not.toHaveBeenCalled()
    t.resume('hover')
    vi.advanceTimersByTime(1499)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('needs every pause reason gone before it resumes', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock)
    t.start(2000, fn)
    t.pause('hover')
    t.pause('dwell')
    t.resume('hover')
    vi.advanceTimersByTime(10_000)
    expect(fn).not.toHaveBeenCalled()
    t.resume('dwell')
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a timer started while paused waits for resume', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock)
    t.pause('hover')
    t.start(1000, fn)
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    t.resume('hover')
    vi.advanceTimersByTime(1500)
    expect(fn).toHaveBeenCalled()
  })

  it('"longer" doubles the time left', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock)
    t.start(4000, fn)
    vi.advanceTimersByTime(1000)
    expect(t.extend()).toBe(true)
    vi.advanceTimersByTime(5999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(t.extend()).toBe(false)
  })

  it('clear drops the pending call', () => {
    const fn = vi.fn()
    const t = new PausableTimer(clock)
    t.start(1000, fn)
    t.clear()
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('answer card voice commands', () => {
  const shown = { ...IDLE_CONTEXT, answerShown: true }

  it('pin / dismiss only apply while an answer shows', () => {
    expect(parseCommand('pin it', shown)?.id).toBe('answer.pin')
    expect(parseCommand('keep that', shown)?.id).toBe('answer.pin')
    expect(parseCommand('dismiss', shown)?.id).toBe('answer.close')
    expect(parseCommand('close', shown)?.id).toBe('answer.close')
    expect(parseCommand('pin it')).toBeNull()
    expect(parseCommand('dismiss')).toBeNull()
    expect(parseCommand('close tab', shown)?.id).not.toBe('answer.close')
  })

  it('"longer" always applies', () => {
    expect(parseCommand('longer')?.id).toBe('answer.longer')
    expect(parseCommand('give me more time')?.id).toBe('answer.longer')
    expect(parseCommand('make the font longer')).toBeNull()
  })

  it('dispatches to the answer io and reports when nothing is there', async () => {
    const f = fakeA11yIo({ answer: true })
    const a = new A11yCommands(f.io)
    a.tryHandle('pin that')
    a.tryHandle('longer')
    a.tryHandle('dismiss')
    await f.settle()
    expect(f.calls.answer).toEqual(['pin', 'longer', 'close'])

    const g = fakeA11yIo({ answer: false })
    new A11yCommands(g.io).tryHandle('longer')
    await g.settle()
    expect(g.calls.feedback.at(-1)).toEqual({ text: 'Nothing is closing', ok: false })
  })
})
