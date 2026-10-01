import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '@shared/routines'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { BgPorts } from '../../src/main/agent-mode/background/handlers'
import { BackgroundManager } from '../../src/main/agent-mode/background/manager'
import { runBackground } from '../../src/main/agent-mode/background/run'
import {
  allowsForeground,
  matchesShape,
  preApproved,
  routineGuard,
  validShape
} from '../../src/main/routines/preapproval'
import {
  MAX_FAILURES,
  RoutineScheduler,
  STALE_MS,
  type RunResult,
  type SchedulerDeps
} from '../../src/main/routines/scheduler'
import { RoutineStore } from '../../src/main/routines/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-routines-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MIN = 60_000

function setup(results: RunResult[] = []): {
  s: RoutineScheduler
  runs: string[]
  saved: Routine[][]
  disabled: string[]
  deps: SchedulerDeps
} {
  const runs: string[] = []
  const saved: Routine[][] = []
  const disabled: string[] = []
  let n = 0
  let i = 0
  const deps: SchedulerDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    run: async (r) => {
      runs.push(r.id)
      return results[Math.min(i++, results.length - 1)] ?? 'done'
    },
    save: (l) => saved.push(l.map((r) => ({ ...r }))),
    disabled: (r) => disabled.push(r.id),
    newId: () => `rt_test${n++}`
  }
  return { s: new RoutineScheduler(deps), runs, saved, disabled, deps }
}

describe('RoutineScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 8, 0)) // Thursday 08:00 local
  })
  afterEach(() => vi.useRealTimers())

  it('runs a daily routine at its time, once a day', async () => {
    const { s, runs } = setup()
    s.start([])
    const r = s.add({
      name: 'News',
      prompt: 'summarize the news',
      schedule: { kind: 'daily', at: '09:00' }
    })!
    expect(s.list()[0].nextRunAt).toBe(new Date(2026, 9, 1, 9, 0).getTime())
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(runs).toEqual([r.id])
    await vi.advanceTimersByTimeAsync(23 * 60 * MIN)
    expect(runs).toEqual([r.id])
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs).toEqual([r.id, r.id])
  })

  it('every N minutes; nothing armed without enabled routines', async () => {
    const { s, runs } = setup()
    s.start([])
    expect(vi.getTimerCount()).toBe(0)
    const r = s.add({
      name: 'Lamp',
      prompt: 'check the lamp',
      schedule: { kind: 'every', minutes: 15 }
    })!
    await vi.advanceTimersByTimeAsync(45 * MIN)
    expect(runs).toEqual([r.id, r.id, r.id])
    s.update(r.id, { enabled: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs.length).toBe(3)
  })

  it('3 failures in a row turn it off and notify; a success resets the counter', async () => {
    const { s, runs, disabled } = setup(['failed', 'failed', 'done', 'failed', 'failed', 'failed'])
    s.start([])
    const r = s.add({
      name: 'X',
      prompt: 'do the thing',
      schedule: { kind: 'every', minutes: 15 }
    })!
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(s.get(r.id)!.failures).toBe(2)
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(s.get(r.id)!.failures).toBe(0)
    await vi.advanceTimersByTimeAsync(45 * MIN)
    expect(runs.length).toBe(6)
    const off = s.get(r.id)!
    expect(off.failures).toBe(MAX_FAILURES)
    expect(off.enabled).toBe(false)
    expect(off.disabledReason).toMatch(/3 failed runs/)
    expect(disabled).toEqual([r.id])
    await vi.advanceTimersByTimeAsync(120 * MIN)
    expect(runs.length).toBe(6)
    // Turned back on: a fresh start.
    s.update(r.id, { enabled: true })
    expect(s.get(r.id)!.failures).toBe(0)
    expect(s.get(r.id)!.disabledReason).toBeUndefined()
  })

  it('a cancelled run is not a failure; a busy routine skips its turn', async () => {
    let release!: (r: RunResult) => void
    const { s, deps } = setup()
    let calls = 0
    deps.run = () => {
      calls++
      return new Promise<RunResult>((res) => (release = res))
    }
    s.start([])
    const r = s.add({
      name: 'Slow',
      prompt: 'slow task here',
      schedule: { kind: 'every', minutes: 15 }
    })!
    await vi.advanceTimersByTimeAsync(31 * MIN)
    expect(calls).toBe(1)
    release('cancelled')
    await vi.advanceTimersByTimeAsync(0)
    expect(s.get(r.id)!.failures).toBe(0)
    expect(s.get(r.id)!.lastResult).toBe('cancelled')
  })

  it('a daily run far too late (sleep) waits for the next day', async () => {
    const { s, runs } = setup()
    s.start([])
    s.add({ name: 'N', prompt: 'news summary please', schedule: { kind: 'daily', at: '09:00' } })
    // The PC slept through 09:00: the clock jumps without timers firing.
    vi.setSystemTime(new Date(2026, 9, 1, 9, 0).getTime() + STALE_MS + MIN)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs).toEqual([])
    expect(s.list()[0].nextRunAt).toBe(new Date(2026, 9, 2, 9, 0).getTime())
  })

  it('no catch-up of runs missed while Lumen was closed', async () => {
    const { s, runs } = setup()
    const r: Routine = {
      id: 'rt_old1',
      name: 'Old',
      prompt: 'old routine',
      schedule: { kind: 'every', minutes: 15 },
      preApproved: [],
      enabled: true,
      failures: 0,
      createdAt: 0,
      lastRunAt: Date.now() - 10 * 60 * MIN
    }
    s.start([r])
    await vi.advanceTimersByTimeAsync(59_000)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toEqual(['rt_old1'])
  })

  it('run now and remove', async () => {
    const { s, runs } = setup()
    s.start([])
    const r = s.add({ name: 'R', prompt: 'run me now', schedule: { kind: 'daily', at: '23:00' } })!
    expect(s.runNow(r.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual([r.id])
    expect(s.remove(r.id)).toBe(true)
    expect(s.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('RoutineStore', () => {
  it('round-trips and drops malformed entries', () => {
    const file = join(dir, 'routines.json')
    const store = new RoutineStore(file)
    const good: Routine = {
      id: 'rt_abcd1',
      name: 'Good',
      prompt: 'p',
      schedule: { kind: 'daily', at: '09:00', days: [1, 2] },
      preApproved: [{ tool: 'request_foreground' }],
      enabled: true,
      failures: 0,
      createdAt: 1
    }
    const bad = { ...good, id: 'rt_bad2', schedule: { kind: 'every', minutes: 5 } }
    store.save([good, bad as Routine])
    expect(store.load()).toEqual([good])
  })
})

describe('pre-approval', () => {
  it('matches tool and argument patterns', () => {
    const shape = { tool: 'mcp__mail__send', args: { to: 'me@example.com', subject: 'Report*' } }
    expect(
      matchesShape(shape, 'mcp__mail__send', { to: 'ME@example.com', subject: 'Report 3' })
    ).toBe(true)
    expect(
      matchesShape(shape, 'mcp__mail__send', { to: 'boss@example.com', subject: 'Report' })
    ).toBe(false)
    expect(matchesShape(shape, 'mcp__mail__send', { to: 'me@example.com' })).toBe(false)
    expect(
      matchesShape(shape, 'mcp__mail__delete', { to: 'me@example.com', subject: 'Report' })
    ).toBe(false)
    expect(matchesShape({ tool: 'mcp__files__*' }, 'mcp__files__read', {})).toBe(true)
    expect(preApproved([], 'request_foreground', {})).toBe(false)
    expect(allowsForeground([{ tool: 'request_foreground' }])).toBe(true)
    expect(allowsForeground([{ tool: 'request_foreground', args: { reason: 'x' } }])).toBe(false)
  })

  it('pattern text is literal except *', () => {
    expect(matchesShape({ tool: 'x', args: { a: 'a.b' } }, 'x', { a: 'aXb' })).toBe(false)
    expect(matchesShape({ tool: 'x', args: { a: '(.*)' } }, 'x', { a: 'anything' })).toBe(false)
  })

  it('validates shapes', () => {
    expect(validShape({ tool: 'request_foreground' })).toBe(true)
    expect(validShape({ tool: 'bad tool' })).toBe(false)
    expect(validShape({ tool: 'x', args: { a: 1 } })).toBe(false)
  })

  it('the routine guard skips high-risk calls unless pre-approved', () => {
    const g = routineGuard([{ tool: 'mcp__mail__send', args: { to: 'me@example.com' } }])
    expect(g('fetch_url', { url: 'https://example.com' })).toBeNull()
    expect(g('request_foreground', { reason: 'x', steps: [] })).toMatch(/pre-approved/)
    expect(g('mcp__mail__send', { to: 'me@example.com' })).toBeNull()
    expect(g('mcp__mail__send', { to: 'boss@example.com' })).toMatch(/pre-approved/)
    expect(routineGuard([{ tool: 'request_foreground' }])('request_foreground', {})).toBeNull()
  })
})

describe('routine runs on the background runner', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const reply = (...calls: ToolCall[]): ToolTurnResult => ({
    message: { role: 'assistant', text: '', calls },
    usage,
    model: 'fake',
    stopReason: calls.length ? 'tool_use' : 'end_turn'
  })

  it('request_foreground without pre-approval never reaches the port', async () => {
    const log: string[] = []
    const ports: BgPorts = {
      taskId: 'bg_r',
      child: false,
      fetch: async (url) => ({
        url,
        status: 200,
        contentType: 'text/plain',
        text: 'x',
        truncated: false
      }),
      readFile: () => ({ ok: false, error: 'E_DENIED' }),
      memorySearch: () => '',
      memoryWrite: () => 'ok',
      notify: () => {},
      ask: async () => '',
      requestForeground: async () => {
        log.push('foreground')
        return { status: 'done', summary: 'clicked' }
      },
      spawn: async () => ({ id: 'bg_c', ok: true }),
      childCount: () => 0,
      progress: () => {},
      audit: (a, r) => log.push(`audit ${String(a.type)} ${r}`)
    }
    const script = [
      reply({
        id: 'c1',
        name: 'request_foreground',
        input: { reason: 'open the app', steps: ['click A'] }
      }),
      reply({ id: 'c2', name: 'finish', input: { summary: 'Skipped the screen part.' } })
    ]
    let i = 0
    const turns: unknown[] = []
    let n = 0
    const m = new BackgroundManager({
      max: () => 3,
      run: (ctl) =>
        runBackground(ctl, {
          caps: { maxModelCalls: 10, maxCostUsd: 1, maxWallMs: 60_000 },
          ports,
          turn: async (req) => {
            turns.push(req)
            return script[Math.min(i++, script.length - 1)]
          },
          costOf: () => 0,
          now: () => Date.now(),
          guard: routineGuard([])
        }),
      emit: () => {},
      now: () => Date.now(),
      newId: () => `bg_rt${n++}`
    })
    const t = m.start({ prompt: 'routine work', origin: 'routine', routineId: 'rt_abcd1' })
    expect(t.routineId).toBe('rt_abcd1')
    const end = await m.wait(t.id)
    expect(end.phase).toBe('done')
    expect(log).not.toContain('foreground')
    expect(log).toContain('audit request_foreground denied')
    expect(JSON.stringify(turns[1])).toContain('E_DENIED')
    // Run again keeps the routine link.
    expect(m.runAgain(t.id)?.routineId).toBe('rt_abcd1')
  })
})
