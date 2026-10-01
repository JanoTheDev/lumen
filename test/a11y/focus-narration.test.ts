import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FocusNarrator,
  REPEAT_MS,
  SETTLE_MS,
  describeFocus
} from '../../src/main/a11y/focus-narration'

describe('describeFocus', () => {
  it('says name and role', () => {
    expect(describeFocus({ name: 'Send', role: 'button' })).toBe('Send, button')
    expect(describeFocus({ name: 'Inbox', role: 'tabitem' })).toBe('Inbox, tab')
    expect(describeFocus({ name: 'Docs', role: 'hyperlink' })).toBe('Docs, link')
  })

  it('adds the value of text fields and the disabled state', () => {
    expect(describeFocus({ name: 'Search', role: 'edit', value: 'cats' })).toBe(
      'Search, edit, cats'
    )
    expect(describeFocus({ name: 'Save', role: 'button', enabled: false })).toBe(
      'Save, button, unavailable'
    )
    expect(describeFocus({ name: 'Ok', role: 'button', value: 'x' })).toBe('Ok, button')
  })

  it('skips unnamed panes and junk', () => {
    expect(describeFocus({ name: '', role: 'pane' })).toBeNull()
    expect(describeFocus({ role: 'window' })).toBeNull()
    expect(describeFocus(null)).toBeNull()
    expect(describeFocus({ name: 'Editor', role: 'pane' })).toBe('Editor')
  })

  it('clips long names', () => {
    const t = describeFocus({ name: 'x'.repeat(200), role: 'button' })!
    expect(t.length).toBeLessThan(100)
  })
})

describe('FocusNarrator', () => {
  let enabled: boolean
  let sr: boolean
  let said: string[]
  let subs: boolean[]
  let n: FocusNarrator

  beforeEach(() => {
    vi.useFakeTimers()
    enabled = true
    sr = false
    said = []
    subs = []
    n = new FocusNarrator(
      {
        enabled: () => enabled,
        screenReaderActive: () => sr,
        announce: (t) => said.push(t),
        subscribe: (on) => subs.push(on),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
      },
      () => Date.now()
    )
  })
  afterEach(() => vi.useRealTimers())

  const focus = (name: string, role = 'button'): void =>
    n.onFocusChanged({ element: { name, role } })

  it('subscribes only while on and no screen reader runs', () => {
    n.sync()
    expect(subs).toEqual([true])
    n.sync()
    expect(subs).toEqual([true])
    sr = true
    n.sync()
    expect(subs).toEqual([true, false])
    sr = false
    enabled = false
    n.sync()
    expect(subs).toEqual([true, false])
    enabled = true
    n.sync()
    expect(subs).toEqual([true, false, true])
  })

  it('speaks where focus settles when tabbing fast', () => {
    focus('One')
    vi.advanceTimersByTime(100)
    focus('Two')
    vi.advanceTimersByTime(100)
    focus('Three')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(said).toEqual(['Three, button'])
  })

  it('does not repeat the same element right away', () => {
    focus('Send')
    vi.advanceTimersByTime(SETTLE_MS)
    focus('Send')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(said).toEqual(['Send, button'])
    vi.advanceTimersByTime(REPEAT_MS)
    focus('Send')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(said).toEqual(['Send, button', 'Send, button'])
  })

  it('stays quiet with a screen reader (no double speech) or when off', () => {
    sr = true
    focus('Send')
    vi.advanceTimersByTime(SETTLE_MS)
    sr = false
    enabled = false
    focus('Send')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(said).toEqual([])
  })

  it('drops a pending line when a screen reader starts', () => {
    n.sync()
    focus('Send')
    sr = true
    n.sync()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(said).toEqual([])
  })
})
