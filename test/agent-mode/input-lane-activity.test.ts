import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers = new Map<string, ((data: unknown) => void)[]>()
  return {
    handlers,
    agent: {
      running: true,
      caps: new Set<string>(['user-activity']),
      hasCapability(c: string): boolean {
        return this.caps.has(c)
      },
      request: vi.fn(() => Promise.resolve({})),
      onEvent(event: string, cb: (data: unknown) => void): void {
        handlers.set(event, [...(handlers.get(event) ?? []), cb])
      }
    }
  }
})
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => h.agent }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))

import {
  inputLane,
  installUserActivityPause,
  USER_PAUSE_MS
} from '../../src/main/agent-mode/input-lane'

const fire = (event: string): void => h.handlers.get(event)?.forEach((cb) => cb({}))
const subscribeCalls = (): unknown[] =>
  h.agent.request.mock.calls.filter((c) => (c as unknown[])[0] === 'subscribe')

describe('physical user activity pauses the lane holder', () => {
  it('subscribes only while the lane is held and pauses on each ping', async () => {
    installUserActivityPause()
    const lane = inputLane()
    expect(subscribeCalls()).toEqual([])

    // Nobody holds the lane: pings (none should come) change nothing.
    fire('user-activity')
    expect(lane.paused()).toBe(false)

    const release = await lane.acquire('agent:t1')
    expect(subscribeCalls()).toEqual([['subscribe', { events: ['user-activity'], enabled: true }]])
    fire('user-activity')
    expect(lane.paused()).toBe(true)

    // A second owner taking over keeps the subscription (no off/on flicker).
    const next = lane.acquire('agent:t2')
    release()
    const release2 = await next
    expect(subscribeCalls()).toHaveLength(1)

    release2()
    expect(subscribeCalls()).toEqual([
      ['subscribe', { events: ['user-activity'], enabled: true }],
      ['subscribe', { events: ['user-activity'], enabled: false }]
    ])
  })

  it('the holder waits USER_PAUSE_MS after a ping before its next batch', async () => {
    vi.useFakeTimers()
    try {
      const lane = inputLane()
      const release = await lane.acquire('agent:t3')
      fire('user-activity')
      let ran = false
      const batch = lane.run('agent:t3', async () => {
        ran = true
      })
      await vi.advanceTimersByTimeAsync(USER_PAUSE_MS - 100)
      expect(ran).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await batch
      expect(ran).toBe(true)
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-asks after an agent restart while held', async () => {
    const lane = inputLane()
    const release = await lane.acquire('agent:t4')
    h.agent.request.mockClear()
    fire('agent-ready')
    expect(subscribeCalls()).toEqual([['subscribe', { events: ['user-activity'], enabled: true }]])
    release()
  })
})
