import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProactiveRule } from '@shared/routines'
import {
  parseProactiveRule,
  ProactiveWatcher,
  RULE_COOLDOWN_MS,
  ruleMatches,
  SETTLE_MS,
  type ForegroundInfo,
  type ProactivePorts
} from '../../src/main/routines/proactive'

function setup(opts: { enabled: boolean; rules?: ProactiveRule[] }): {
  w: ProactiveWatcher
  calls: string[]
  said: string[]
  state: { enabled: boolean; rules: ProactiveRule[]; win: ForegroundInfo }
} {
  const calls: string[] = []
  const said: string[] = []
  const state = {
    enabled: opts.enabled,
    rules: opts.rules ?? [{ id: 'pr_aaaa1', app: 'Resolve', say: 'Remember to back up.' }],
    win: { process: 'Resolve.exe', title: 'Project 1 - DaVinci Resolve' } as ForegroundInfo
  }
  const ports: ProactivePorts = {
    enabled: () => state.enabled,
    rules: () => state.rules,
    subscribe: (on) => calls.push(`subscribe ${on}`),
    foreground: async () => {
      calls.push('foreground')
      return state.win
    },
    say: (t) => said.push(t),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout)
  }
  return { w: new ProactiveWatcher(ports), calls, said, state }
}

describe('proactive mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('off: no subscription, no window queries, nothing said (no captures, no model)', async () => {
    const { w, calls, said } = setup({ enabled: false })
    w.sync()
    for (let i = 0; i < 5; i++) w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual([])
    expect(said).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('on without rules: still nothing', async () => {
    const { w, calls } = setup({ enabled: true, rules: [] })
    w.sync()
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual([])
  })

  it('on: says the reminder when the app comes to the front, once per cooldown', async () => {
    const { w, calls, said, state } = setup({ enabled: true })
    w.sync()
    expect(calls).toEqual(['subscribe true'])
    // A burst of focus events settles into one look at the window.
    w.onFocusChanged()
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(calls.filter((c) => c === 'foreground')).toHaveLength(1)
    expect(said).toEqual(['Remember to back up.'])
    // Focus moving inside the same app: quiet.
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(said).toHaveLength(1)
    // Away and back within the cooldown: quiet.
    state.win = { process: 'chrome.exe', title: 'News' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    state.win = { process: 'Resolve.exe', title: 'Resolve' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(said).toHaveLength(1)
    // After the cooldown: again.
    state.win = { process: 'chrome.exe', title: 'News' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(RULE_COOLDOWN_MS)
    state.win = { process: 'Resolve.exe', title: 'Resolve' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(said).toHaveLength(2)
  })

  it('turning it off unsubscribes and stops at once', async () => {
    const { w, calls, said, state } = setup({ enabled: true })
    w.sync()
    w.onFocusChanged()
    state.enabled = false
    w.sync()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual(['subscribe true', 'subscribe false'])
    expect(said).toEqual([])
  })
})

describe('rules', () => {
  it('parses spoken rules', () => {
    expect(parseProactiveRule('When I open Resolve, remind me to back up.')).toEqual({
      app: 'Resolve',
      say: 'Remember to back up.'
    })
    expect(parseProactiveRule('whenever I start Blender tell me to save often')).toEqual({
      app: 'Blender',
      say: 'Save often.'
    })
    expect(
      parseProactiveRule('every time I open the Excel app remind me about the budget')
    ).toEqual({ app: 'Excel', say: 'Reminder: the budget.' })
    expect(parseProactiveRule('open Resolve')).toBeNull()
    expect(parseProactiveRule('remind me to back up')).toBeNull()
  })

  it('matches by process or window title', () => {
    expect(ruleMatches('Resolve', { process: 'Resolve.exe' })).toBe(true)
    expect(ruleMatches('DaVinci Resolve', { process: 'Resolve.exe' })).toBe(true)
    expect(ruleMatches('blender', { process: 'blender.exe' })).toBe(true)
    expect(ruleMatches('Excel', { process: 'EXCEL.EXE' })).toBe(true)
    expect(
      ruleMatches('Word', { process: 'chrome.exe', title: 'Microsoft Word tips - Chrome' })
    ).toBe(true)
    expect(ruleMatches('Word', { process: 'chrome.exe', title: 'Wordle - Chrome' })).toBe(false)
    expect(ruleMatches('Resolve', { process: 'explorer.exe', title: 'Downloads' })).toBe(false)
  })
})
