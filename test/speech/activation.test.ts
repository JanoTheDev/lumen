import { describe, expect, it } from 'vitest'
import {
  AssistantActivation,
  SESSION_MAX_MS,
  TAP_MS,
  type ActivationMode,
  type Timers
} from '../../src/main/speech/activation'

interface Harness {
  a: AssistantActivation
  calls: string[]
  advance: (ms: number) => void
  setMode: (x: ActivationMode) => void
}

function setup(mode: ActivationMode = 'hold'): Harness {
  const calls: string[] = []
  const pending: { fn: () => void; at: number; id: number }[] = []
  let now = 0
  let ids = 0
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++ids
      pending.push({ fn, at: now + ms, id })
      return id
    },
    clear: (h) => {
      const i = pending.findIndex((p) => p.id === h)
      if (i >= 0) pending.splice(i, 1)
    }
  }
  let m = mode
  const a = new AssistantActivation(
    {
      start: (hf) => calls.push(hf ? 'start-hf' : 'start'),
      handsFree: () => calls.push('hands-free'),
      stop: () => calls.push('stop')
    },
    () => m,
    timers
  )
  const advance = (ms: number): void => {
    now += ms
    for (const p of [...pending].filter((p) => p.at <= now)) {
      pending.splice(pending.indexOf(p), 1)
      p.fn()
    }
  }
  const setMode = (x: ActivationMode): void => {
    m = x
  }
  return { a, calls, advance, setMode }
}

describe('AssistantActivation hold mode', () => {
  it('hold and release sends', () => {
    const { a, calls } = setup()
    a.down(0)
    a.up(TAP_MS + 500)
    expect(calls).toEqual(['start', 'stop'])
    expect(a.current).toBe('idle')
  })

  it('a quick tap keeps listening hands-free instead of being lost', () => {
    const { a, calls } = setup()
    a.down(0)
    a.up(80)
    expect(calls).toEqual(['start', 'hands-free'])
    expect(a.current).toBe('hands-free')
  })

  it('a second tap sends a hands-free recording early', () => {
    const { a, calls } = setup()
    a.down(0)
    a.up(80)
    a.down(2000)
    a.up(2100)
    expect(calls).toEqual(['start', 'hands-free', 'stop'])
    expect(a.current).toBe('idle')
  })

  it('after the renderer ends the recording, the next press starts a new one', () => {
    const { a, calls } = setup()
    a.down(0)
    a.up(80)
    a.reset()
    a.down(5000)
    expect(calls).toEqual(['start', 'hands-free', 'start'])
  })

  it('forgets a hands-free session that never reported its end', () => {
    const { a, calls, advance } = setup()
    a.down(0)
    a.up(80)
    advance(SESSION_MAX_MS + 1)
    expect(a.current).toBe('idle')
    a.down(SESSION_MAX_MS + 10)
    expect(calls.at(-1)).toBe('start')
  })

  it('ignores key repeat while held', () => {
    const { a, calls } = setup()
    a.down(0)
    a.down(30)
    a.down(60)
    a.up(1000)
    expect(calls).toEqual(['start', 'stop'])
  })
})

describe('AssistantActivation tap mode', () => {
  it('press starts hands-free, release does nothing, next press sends', () => {
    const { a, calls } = setup('tap')
    a.down(0)
    a.up(1500)
    expect(calls).toEqual(['start-hf'])
    a.down(3000)
    a.up(3100)
    expect(calls).toEqual(['start-hf', 'stop'])
    expect(a.current).toBe('idle')
  })

  it('mode changes apply on the next press', () => {
    const { a, calls, setMode } = setup('tap')
    a.down(0)
    a.reset()
    setMode('hold')
    a.down(100)
    a.up(1000)
    expect(calls).toEqual(['start-hf', 'start', 'stop'])
  })
})
