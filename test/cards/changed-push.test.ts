// cards:changed reaches only the windows that show cards (bar and panel), once per burst of
// image loads instead of once per image.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendTo: vi.fn(),
  bar: { name: 'bar' },
  panel: { name: 'panel' }
}))

vi.mock('../../src/main/windows/registry', () => ({
  broadcast: h.broadcast,
  sendTo: h.sendTo
}))
vi.mock('../../src/main/windows/assistant', () => ({ get: () => h.bar }))
vi.mock('../../src/main/windows/settings', () => ({ get: () => h.panel }))

import { bus } from '../../src/main/bus'
import '../../src/main/windows/cards'

const pushes = (): number => h.broadcast.mock.calls.length + h.sendTo.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers()
  h.broadcast.mockClear()
  h.sendTo.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('cards:changed push', () => {
  it('twelve image loads within 100 ms make one push per window', () => {
    for (let i = 0; i < 12; i++) {
      bus.emit({ type: 'cards.changed', id: 'c_abcd1234' })
      vi.advanceTimersByTime(8)
    }
    vi.advanceTimersByTime(200)
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(h.sendTo.mock.calls).toEqual([
      [h.bar, 'cards:changed', 'c_abcd1234'],
      [h.panel, 'cards:changed', 'c_abcd1234']
    ])
  })

  it('keeps sets apart and pushes again for a later change', () => {
    bus.emit({ type: 'cards.changed', id: 'c_aaaa1111' })
    bus.emit({ type: 'cards.changed', id: 'c_bbbb2222' })
    vi.advanceTimersByTime(200)
    expect(pushes()).toBe(4)
    bus.emit({ type: 'cards.changed', id: 'c_aaaa1111' })
    vi.advanceTimersByTime(200)
    expect(pushes()).toBe(6)
  })

  it('a steady stream still pushes while images keep arriving', () => {
    for (let i = 0; i < 20; i++) {
      bus.emit({ type: 'cards.changed', id: 'c_cccc3333' })
      vi.advanceTimersByTime(100)
    }
    expect(pushes()).toBeGreaterThan(2)
  })
})
