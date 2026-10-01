import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const registered = new Map<string, () => void>()
vi.mock('electron', () => ({
  globalShortcut: {
    isRegistered: (k: string) => registered.has(k),
    register: (k: string, fn: () => void) => registered.set(k, fn),
    unregister: (k: string) => registered.delete(k)
  }
}))

import {
  armEscape,
  disarmEscape,
  holdEscape,
  keepEscapeWhile,
  releaseEscape,
  resetEscape,
  setEscapeHandler
} from '../src/main/agent/escape'

describe('escape', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    resetEscape()
  })
  afterEach(() => {
    resetEscape()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays registered until every reference is released', () => {
    armEscape()
    armEscape()
    expect(registered.has('Escape')).toBe(true)
    disarmEscape()
    expect(registered.has('Escape')).toBe(true)
    disarmEscape()
    expect(registered.has('Escape')).toBe(false)
  })

  it('named holds are idempotent', () => {
    holdEscape('hud')
    holdEscape('hud')
    armEscape()
    releaseEscape('hud')
    expect(registered.has('Escape')).toBe(true)
    disarmEscape()
    expect(registered.has('Escape')).toBe(false)
  })

  it('extra disarms do not go negative', () => {
    disarmEscape()
    armEscape()
    expect(registered.has('Escape')).toBe(true)
  })

  it('watchdog releases Escape after 60s without activity', () => {
    armEscape()
    vi.advanceTimersByTime(59_000)
    expect(registered.has('Escape')).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(registered.has('Escape')).toBe(false)
  })

  it('invokes the handler on Escape', () => {
    const fn = vi.fn()
    setEscapeHandler(fn)
    holdEscape('hud')
    registered.get('Escape')?.()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('watchdog keeps Escape while a turn is still running', async () => {
    const { beginScope, endScope } = await import('../src/main/query/cancel')
    const scope = beginScope()
    armEscape()
    vi.advanceTimersByTime(61_000)
    expect(registered.has('Escape')).toBe(true)
    endScope(scope)
    vi.advanceTimersByTime(61_000)
    expect(registered.has('Escape')).toBe(false)
  })

  it('watchdog keeps Escape while a long session is active', () => {
    let active = true
    const stop = keepEscapeWhile(() => active)
    holdEscape('hud')
    vi.advanceTimersByTime(150_000)
    expect(registered.has('Escape')).toBe(true)
    active = false
    vi.advanceTimersByTime(61_000)
    expect(registered.has('Escape')).toBe(false)
    stop()
  })
})
