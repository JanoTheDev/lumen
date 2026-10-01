import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  agent: {
    running: true,
    caps: new Set<string>(),
    hasCapability(c: string): boolean {
      return this.caps.has(c)
    },
    request: vi.fn(() => Promise.resolve({}))
  }
}))
vi.mock('../src/main/agent/instance', () => ({ getAgent: () => h.agent }))
vi.mock('../src/main/logger', () => ({ log: vi.fn() }))

import { moveGate, refCountedSubscription } from '../src/main/agent/subscriptions'

describe('refCountedSubscription', () => {
  it('subscribes on the first owner and unsubscribes after the last', () => {
    const sub = refCountedSubscription('mouse-moved')
    sub.want('buddy', true)
    sub.want('guide', true)
    sub.want('buddy', false)
    expect(sub.wanted()).toBe(true)
    sub.want('guide', false)
    expect(sub.wanted()).toBe(false)
    expect(h.agent.request.mock.calls).toEqual([
      ['subscribe', { events: ['mouse-moved'], enabled: true }],
      ['subscribe', { events: ['mouse-moved'], enabled: false }]
    ])
  })
})

describe('refCountedSubscription with a capability', () => {
  it('only asks an agent that reports the capability', () => {
    h.agent.request.mockClear()
    const sub = refCountedSubscription('key-combo', 'key-combo')
    sub.want('lesson', true)
    expect(h.agent.request).not.toHaveBeenCalled()
    expect(sub.wanted()).toBe(true)
    h.agent.caps.add('key-combo')
    sub.push()
    expect(h.agent.request.mock.calls).toEqual([
      ['subscribe', { events: ['key-combo'], enabled: true }]
    ])
  })
})

describe('moveGate', () => {
  it('passes once the cursor leaves the radius, then re-anchors', () => {
    const gate = moveGate(12)
    expect(gate({ x: 0, y: 0 })).toBe(false)
    expect(gate({ x: 8, y: 8 })).toBe(false)
    expect(gate({ x: 10, y: 10 })).toBe(true)
    expect(gate({ x: 15, y: 10 })).toBe(false)
    expect(gate({ x: 30, y: 10 })).toBe(true)
  })
})
