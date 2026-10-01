import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '@shared/automations'
import {
  AutomationScheduler,
  DEDUPE_MS,
  EVENT_MAX_PER_HOUR,
  MAX_FAILURES,
  STALE_MS,
  STARTUP_DELAY_MS,
  type EngineDeps,
  type RunEnd
} from '../../src/main/routines/engine'

const MIN = 60_000

function setup(results: RunEnd['result'][] = []): {
  s: AutomationScheduler
  runs: string[]
  details: (string | undefined)[]
  disabled: string[]
  deps: EngineDeps
  external: Set<string>
} {
  const runs: string[] = []
  const details: (string | undefined)[] = []
  const disabled: string[] = []
  const external = new Set<string>()
  let n = 0
  let i = 0
  const deps: EngineDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    run: async (a, ctx) => {
      runs.push(`${a.id}:${ctx.via}`)
      details.push(ctx.detail)
      return { result: results[Math.min(i++, results.length - 1)] ?? 'done', summary: 'ok' }
    },
    save: () => {},
    disabled: (a) => disabled.push(a.id),
    newId: () => `au_test${n++}`,
    external: (a) => external.has(a.id)
  }
  return { s: new AutomationScheduler(deps), runs, details, disabled, deps, external }
}

const base = (p: Partial<Automation> & Pick<Automation, 'id' | 'trigger'>): Automation => ({
  name: 'X',
  action: { kind: 'task', prompt: 'do the thing' },
  preApproved: [],
  enabled: true,
  failures: 0,
  createdAt: 0,
  ...p
})

describe('AutomationScheduler: time triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 8, 0)) // Thursday 08:00 local
  })
  afterEach(() => vi.useRealTimers())

  it('runs a daily automation at its time, once a day, with run history', async () => {
    const { s, runs } = setup()
    s.start([])
    const a = s.add({
      name: 'News',
      trigger: { kind: 'daily', at: '09:00' },
      action: { kind: 'task', prompt: 'summarize the news' }
    })!
    expect(s.list()[0].nextRunAt).toBe(new Date(2026, 9, 1, 9, 0).getTime())
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs).toEqual([`${a.id}:time`])
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN)
    expect(runs).toHaveLength(2)
    expect(s.get(a.id)!.runs).toMatchObject([
      { result: 'done', via: 'time', summary: 'ok' },
      { result: 'done', via: 'time' }
    ])
  })

  it('every N minutes; nothing armed without enabled time automations', async () => {
    const { s, runs } = setup()
    s.start([])
    expect(vi.getTimerCount()).toBe(0)
    const a = s.add({
      name: 'Lamp',
      trigger: { kind: 'every', minutes: 15 },
      action: { kind: 'task', prompt: 'check the lamp' }
    })!
    await vi.advanceTimersByTimeAsync(45 * MIN)
    expect(runs).toHaveLength(3)
    s.update(a.id, { enabled: false })
    expect(vi.getTimerCount()).toBe(0)
    s.add({
      name: 'App',
      trigger: { kind: 'app', app: 'Excel', on: 'open' },
      action: { kind: 'remind', say: 'Hi.' }
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a window run: every hour between 9 and 17', async () => {
    const { s, runs } = setup()
    s.start([])
    s.add({
      name: 'W',
      trigger: { kind: 'every', minutes: 60, from: '09:00', to: '17:00' },
      action: { kind: 'task', prompt: 'check the build' }
    })
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN)
    // 09:00 … 17:00 = 9 runs.
    expect(runs).toHaveLength(9)
  })

  it('3 failures in a row turn it off and notify; a success resets the counter', async () => {
    const { s, runs, disabled } = setup(['failed', 'failed', 'done', 'failed', 'failed', 'failed'])
    s.start([])
    const a = s.add({
      name: 'X',
      trigger: { kind: 'every', minutes: 15 },
      action: { kind: 'task', prompt: 'do the thing' }
    })!
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(s.get(a.id)!.failures).toBe(2)
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(s.get(a.id)!.failures).toBe(0)
    await vi.advanceTimersByTimeAsync(45 * MIN)
    expect(runs).toHaveLength(6)
    const off = s.get(a.id)!
    expect(off.failures).toBe(MAX_FAILURES)
    expect(off.enabled).toBe(false)
    expect(off.disabledReason).toMatch(/3 failed runs/)
    expect(disabled).toEqual([a.id])
    s.update(a.id, { enabled: true })
    expect(s.get(a.id)!.failures).toBe(0)
  })

  it('a one-off runs once and turns itself off', async () => {
    const { s, runs } = setup()
    s.start([])
    const a = s.add({
      name: 'Once',
      trigger: { kind: 'once', at: Date.now() + 20 * MIN },
      action: { kind: 'remind', say: 'Stretch.' }
    })!
    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(runs).toEqual([`${a.id}:time`])
    expect(s.get(a.id)!.enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(48 * 60 * MIN)
    expect(runs).toHaveLength(1)
  })

  it('a time run far too late (sleep) waits for the next turn', async () => {
    const { s, runs } = setup()
    s.start([])
    s.add({
      name: 'N',
      trigger: { kind: 'daily', at: '09:00' },
      action: { kind: 'task', prompt: 'news please' }
    })
    vi.setSystemTime(new Date(2026, 9, 1, 9, 0).getTime() + STALE_MS + MIN)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs).toEqual([])
    expect(s.list()[0].nextRunAt).toBe(new Date(2026, 9, 2, 9, 0).getTime())
  })
})

describe('AutomationScheduler: start, catch-up, wake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('missed runs are not caught up by default; with catchUp they run once after start', async () => {
    const { s, runs } = setup()
    const yesterday = new Date(2026, 8, 30, 12, 0).getTime()
    s.start([
      base({ id: 'au_miss1', trigger: { kind: 'daily', at: '09:00' }, lastRunAt: yesterday }),
      base({
        id: 'au_miss2',
        trigger: { kind: 'daily', at: '09:00' },
        lastRunAt: yesterday,
        catchUp: true
      })
    ])
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    expect(runs).toEqual(['au_miss2:catch-up'])
    // Both are back on their schedule.
    await vi.advanceTimersByTimeAsync(21 * 60 * MIN)
    expect(runs.filter((r) => r.endsWith(':time')).sort()).toEqual([
      'au_miss1:time',
      'au_miss2:time'
    ])
  })

  it('a missed one-off is skipped (off) unless catchUp', async () => {
    const { s, runs } = setup()
    s.start([
      base({ id: 'au_once1', trigger: { kind: 'once', at: Date.now() - 2 * 60 * MIN } }),
      base({
        id: 'au_once2',
        trigger: { kind: 'once', at: Date.now() - 2 * 60 * MIN },
        catchUp: true
      })
    ])
    expect(s.get('au_once1')!.enabled).toBe(false)
    expect(s.get('au_once1')!.runs?.[0]).toMatchObject({ result: 'skipped' })
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    expect(runs).toEqual(['au_once2:catch-up'])
    expect(s.get('au_once2')!.enabled).toBe(false)
  })

  it('startup triggers run once, a minute after start', async () => {
    const { s, runs } = setup()
    s.start([base({ id: 'au_boot1', trigger: { kind: 'startup' } })])
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toEqual(['au_boot1:event'])
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN)
    expect(runs).toHaveLength(1)
  })

  it('wake: Task Scheduler drives it (no in-process timer); a wake run is not run twice', async () => {
    const { s, runs, external } = setup()
    external.add('au_wake1')
    s.start([base({ id: 'au_wake1', trigger: { kind: 'daily', at: '13:00' }, wake: true })])
    expect(vi.getTimerCount()).toBe(0)
    // Shown with its next time anyway.
    expect(s.list()[0].nextRunAt).toBe(new Date(2026, 9, 1, 13, 0).getTime())
    vi.setSystemTime(new Date(2026, 9, 1, 13, 0))
    expect(s.runWake('au_wake1')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.runWake('au_wake1')).toBe(false)
    await vi.advanceTimersByTimeAsync(DEDUPE_MS)
    expect(runs).toEqual(['au_wake1:wake'])
    expect(s.runWake('au_nope1')).toBe(false)
  })

  it('a timer run right after a wake run of the same time is skipped', async () => {
    const { s, runs } = setup()
    s.start([base({ id: 'au_dup1', trigger: { kind: 'daily', at: '12:30' } })])
    vi.setSystemTime(new Date(2026, 9, 1, 12, 29, 58))
    s.runWake('au_dup1')
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs).toEqual(['au_dup1:wake'])
  })
})

describe('AutomationScheduler: events', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires event automations, queues details while busy, caps per hour', async () => {
    const { s, deps, details } = setup()
    const releases: ((e: RunEnd) => void)[] = []
    deps.run = (_a, ctx) => {
      details.push(ctx.detail)
      return new Promise((res) => releases.push(res))
    }
    s.start([base({ id: 'au_file1', trigger: { kind: 'file', folder: 'C:\\D', on: 'added' } })])
    expect(s.fireEvent('au_file1', 'a.pdf')).toBe(true)
    expect(s.fireEvent('au_file1', 'b.pdf')).toBe(true)
    expect(s.fireEvent('au_file1', 'b.pdf')).toBe(true)
    expect(details).toEqual(['a.pdf'])
    releases[0]({ result: 'done' })
    await vi.advanceTimersByTimeAsync(0)
    expect(details).toEqual(['a.pdf', 'b.pdf'])
    releases[1]({ result: 'done' })
    await vi.advanceTimersByTimeAsync(0)
    // Time triggers and unknown / off automations do not take events.
    s.start([
      base({ id: 'au_time1', trigger: { kind: 'daily', at: '09:00' } }),
      base({ id: 'au_off01', trigger: { kind: 'online' }, enabled: false })
    ])
    expect(s.fireEvent('au_time1')).toBe(false)
    expect(s.fireEvent('au_off01')).toBe(false)
    expect(s.fireEvent('au_gone1')).toBe(false)
  })

  it('at most EVENT_MAX_PER_HOUR runs an hour', async () => {
    const { s, runs } = setup()
    s.start([base({ id: 'au_many1', trigger: { kind: 'online' } })])
    let ok = 0
    for (let i = 0; i < EVENT_MAX_PER_HOUR + 5; i++) {
      if (s.fireEvent('au_many1')) ok++
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(ok).toBe(EVENT_MAX_PER_HOUR)
    expect(runs).toHaveLength(EVENT_MAX_PER_HOUR)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(s.fireEvent('au_many1')).toBe(true)
  })

  it('run now and remove', async () => {
    const { s, runs } = setup()
    s.start([])
    const a = s.add({
      name: 'R',
      trigger: { kind: 'daily', at: '23:00' },
      action: { kind: 'task', prompt: 'run me' }
    })!
    expect(s.runNow(a.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual([`${a.id}:manual`])
    expect(s.remove(a.id)).toBe(true)
    expect(s.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
