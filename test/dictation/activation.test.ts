import { describe, expect, it } from 'vitest'
import {
  DictationActivation,
  DOUBLE_TAP_GAP_MS,
  HANDS_FREE_MAX_MS,
  TAP_MS,
  type Timers
} from '../../src/main/speech/dictation/activation'

function setup(): {
  calls: string[]
  act: DictationActivation
  advance: (ms: number) => void
  down: () => void
  up: () => void
} {
  const calls: string[] = []
  let pending: { fn: () => void; at: number } | null = null
  let now = 0
  const timers: Timers = {
    set: (fn, ms) => (pending = { fn, at: now + ms }),
    clear: () => (pending = null)
  }
  const act = new DictationActivation(
    {
      start: () => calls.push('start'),
      handsFree: () => calls.push('hands-free'),
      stop: () => calls.push('stop'),
      cancel: (r) => calls.push(`cancel:${r}`)
    },
    timers
  )
  const advance = (ms: number): void => {
    now += ms
    if (pending && pending.at <= now) {
      const p = pending
      pending = null
      p.fn()
    }
  }
  return {
    calls,
    act,
    advance,
    down: () => act.down(now),
    up: () => act.up(now)
  }
}

describe('dictation activation', () => {
  it('hold: records while held and types on release', () => {
    const t = setup()
    t.down()
    t.advance(1500)
    t.down() // key repeat
    t.up()
    expect(t.calls).toEqual(['start', 'stop'])
    expect(t.act.active).toBe(false)
  })

  it('double-tap: hands-free until the next tap', () => {
    const t = setup()
    t.down()
    t.advance(80)
    t.up()
    t.advance(DOUBLE_TAP_GAP_MS - 50)
    t.down()
    t.advance(80)
    t.up()
    expect(t.calls).toEqual(['start', 'hands-free'])
    expect(t.act.current).toBe('hands-free')
    t.advance(5000)
    t.down()
    t.up()
    expect(t.calls).toEqual(['start', 'hands-free', 'stop'])
    expect(t.act.active).toBe(false)
  })

  it('a lone quick tap cancels with a hint instead of typing', () => {
    const t = setup()
    t.down()
    t.advance(TAP_MS - 1)
    t.up()
    t.advance(DOUBLE_TAP_GAP_MS)
    expect(t.calls).toEqual(['start', 'cancel:tap'])
    expect(t.act.active).toBe(false)
  })

  it('hands-free stops on its own after the safety limit', () => {
    const t = setup()
    t.down()
    t.up()
    t.down()
    t.up()
    t.advance(HANDS_FREE_MAX_MS)
    expect(t.calls).toEqual(['start', 'hands-free', 'stop'])
  })

  it('reset (silence auto-stop, Escape) returns to idle and drops timers', () => {
    const t = setup()
    t.down()
    t.up()
    t.act.reset()
    t.advance(DOUBLE_TAP_GAP_MS)
    expect(t.calls).toEqual(['start'])
    t.down()
    expect(t.calls).toEqual(['start', 'start'])
  })
})
