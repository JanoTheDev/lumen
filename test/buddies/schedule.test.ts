// Buddy schedules (08 T52): automations with action buddy, scheduleIds kept in sync, skipped
// runs (paused, off, monthly limit) that never count as failures, and the pause flag.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { Automation } from '@shared/automations'
import type { Buddy } from '@shared/buddies'
import type { BackgroundTask } from '@shared/types'
import {
  addBuddySchedule,
  BuddyPauseFlag,
  orphanSchedules,
  removeBuddySchedule,
  replaceBuddySchedule,
  resetBudgetNotices,
  runScheduledBuddy,
  scheduleIdChanges,
  setScheduleHost,
  SKIP_BUDGET,
  SKIP_OFF,
  SKIP_PAUSED,
  type ScheduledRunDeps,
  type ScheduleHost
} from '../../src/main/buddies/schedule'
import { AutomationScheduler, type RunEnd } from '../../src/main/routines/engine'
import { actionSchema } from '../../src/main/routines/automation-store'
import { describeAction, setBuddyNamer } from '../../src/main/routines/triggers'
import { ownWords } from '../../src/main/routines/run-prompt'
import { tempDir } from '../helpers/fixtures'

const auto = (
  id: string,
  action: Automation['action'],
  p: Partial<Automation> = {}
): Automation => ({
  id,
  name: 'x',
  trigger: { kind: 'daily', at: '08:00' },
  action,
  preApproved: [],
  enabled: true,
  failures: 0,
  createdAt: 0,
  ...p
})

const buddy = (p: Partial<Buddy> = {}): Buddy =>
  ({
    id: 'inbox-buddy',
    name: 'Inbox Buddy',
    enabled: true,
    scheduleIds: [],
    permissions: { screen: false, input: false },
    ...p
  }) as unknown as Buddy

describe('the buddy action', () => {
  it('is a valid automation action with a readable description', () => {
    expect(actionSchema.safeParse({ kind: 'buddy', buddyId: 'inbox-buddy' }).success).toBe(true)
    expect(actionSchema.safeParse({ kind: 'buddy', buddyId: '../x' }).success).toBe(false)
    setBuddyNamer((id) => (id === 'inbox-buddy' ? 'Inbox Buddy' : null))
    expect(describeAction({ kind: 'buddy', buddyId: 'inbox-buddy' })).toBe('run Inbox Buddy')
    expect(describeAction({ kind: 'buddy', buddyId: 'gone', prompt: 'x' })).toBe(
      'run the buddy “gone” (x)'
    )
    setBuddyNamer(() => null)
    expect(ownWords(auto('au_1', { kind: 'buddy', buddyId: 'b', prompt: 'only Sony' }))).toBe(
      'only Sony'
    )
  })
})

describe('scheduleIds', () => {
  it('follow the automations list; orphans are found', () => {
    const list = [
      auto('au_a', { kind: 'buddy', buddyId: 'inbox-buddy' }),
      auto('au_b', { kind: 'task', prompt: 'x' }),
      auto('au_c', { kind: 'buddy', buddyId: 'gone-buddy' })
    ]
    const buddies = [
      { id: 'inbox-buddy', scheduleIds: ['au_old'] },
      { id: 'price-buddy', scheduleIds: [] }
    ]
    expect(scheduleIdChanges(buddies, list)).toEqual([{ id: 'inbox-buddy', scheduleIds: ['au_a'] }])
    expect(orphanSchedules(list, (id) => id !== 'gone-buddy')).toEqual(['au_c'])
  })
})

describe('a scheduled run', () => {
  beforeEach(() => resetBudgetNotices())

  function deps(p: Partial<ScheduledRunDeps> = {}): ScheduledRunDeps {
    return {
      pausedAll: () => false,
      getBuddy: () => buddy(),
      run: vi.fn(() => ({ ok: true as const, task: { id: 'bg_t1' } as BackgroundTask })),
      wait: async () =>
        ({ id: 'bg_t1', phase: 'done', result: { summary: '3 new mails' } }) as BackgroundTask,
      notice: vi.fn(),
      now: () => new Date(2026, 9, 2).getTime(),
      ...p
    }
  }
  const a = auto('au_a', { kind: 'buddy', buddyId: 'inbox-buddy', prompt: 'only from my boss' })

  it('runs the buddy with the schedule words and the event detail', async () => {
    const d = deps()
    const end = await runScheduledBuddy(a, { via: 'time', detail: '(why)' }, d)
    expect(end).toEqual({ result: 'done', summary: '3 new mails', taskId: 'bg_t1' })
    expect(d.run).toHaveBeenCalledWith('inbox-buddy', {
      trigger: 'schedule',
      utterance: 'only from my boss',
      detail: '(why)'
    })
  })

  it('skips while paused, off or past its monthly limit (one notice a month)', async () => {
    expect(await runScheduledBuddy(a, { via: 'time' }, deps({ pausedAll: () => true }))).toEqual({
      result: 'skipped',
      summary: SKIP_PAUSED
    })
    expect(
      await runScheduledBuddy(
        a,
        { via: 'time' },
        deps({ getBuddy: () => buddy({ enabled: false }) })
      )
    ).toEqual({ result: 'skipped', summary: SKIP_OFF })
    const notice = vi.fn()
    const d = deps({
      notice,
      run: () => ({ ok: false, code: 'E_BUDGET', error: 'Inbox Buddy used its budget.' })
    })
    expect(await runScheduledBuddy(a, { via: 'time' }, d)).toEqual({
      result: 'skipped',
      summary: SKIP_BUDGET
    })
    await runScheduledBuddy(a, { via: 'time' }, d)
    expect(notice).toHaveBeenCalledTimes(1)
    expect(
      await runScheduledBuddy(a, { via: 'time' }, deps({ getBuddy: () => null }))
    ).toMatchObject({ result: 'failed' })
  })

  it('goes on screen when the foreground port takes it', async () => {
    const run = vi.fn()
    const end = await runScheduledBuddy(
      a,
      { via: 'time' },
      deps({ run, foreground: () => Promise.resolve({ result: 'done', summary: 'did it' }) })
    )
    expect(end).toEqual({ result: 'done', summary: 'did it' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the scheduler and skipped runs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('records a skipped run without counting a failure', async () => {
    const results: RunEnd[] = [
      { result: 'skipped', summary: SKIP_BUDGET },
      { result: 'skipped', summary: SKIP_BUDGET },
      { result: 'skipped', summary: SKIP_BUDGET }
    ]
    let i = 0
    let n = 0
    const s = new AutomationScheduler({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      run: async () => results[i++],
      save: () => {},
      newId: () => `au_t${n++}`
    })
    s.start([])
    const a = s.add({
      name: 'Inbox Buddy',
      trigger: { kind: 'daily', at: '08:00' },
      action: { kind: 'buddy', buddyId: 'inbox-buddy' }
    })!
    for (let k = 0; k < 3; k++) {
      s.runNow(a.id)
      await vi.advanceTimersByTimeAsync(10)
    }
    const after = s.get(a.id)!
    expect(after.enabled).toBe(true)
    expect(after.failures).toBe(0)
    expect(after.lastResult).toBeUndefined()
    expect(after.runs?.map((r) => r.result)).toEqual(['skipped', 'skipped', 'skipped'])
    s.stop()
  })
})

describe('adding and removing schedules', () => {
  let list: Automation[]
  let ids: Record<string, string[]>
  let host: ScheduleHost
  beforeEach(() => {
    list = [auto('au_other', { kind: 'buddy', buddyId: 'price-buddy' })]
    ids = {}
    let n = 0
    host = {
      automations: () => list,
      add: async (input) => {
        if (typeof input.when === 'string' && input.when === 'whenever')
          return 'I could not read that time.'
        const a = auto(`au_n${n++}`, input.action)
        list = [...list, a]
        return a
      },
      remove: (id) => {
        const before = list.length
        list = list.filter((a) => a.id !== id)
        return list.length < before
      },
      buddies: () => [
        buddy({ scheduleIds: ids['inbox-buddy'] ?? [] }),
        buddy({ id: 'price-buddy', name: 'Price Buddy', scheduleIds: ids['price-buddy'] ?? [] })
      ],
      getBuddy: (id) => (id === 'inbox-buddy' ? buddy() : null),
      setScheduleIds: (id, s) => (ids[id] = s)
    }
    setScheduleHost(host)
  })
  afterEach(() => setScheduleHost(null))

  it('adds one and keeps scheduleIds in sync', async () => {
    const r = await addBuddySchedule('inbox-buddy', 'every weekday at 8', { prompt: 'be brief' })
    expect(r).toEqual({ ok: true, automationId: 'au_n0' })
    expect(list[1].action).toEqual({ kind: 'buddy', buddyId: 'inbox-buddy', prompt: 'be brief' })
    expect(ids['inbox-buddy']).toEqual(['au_n0'])
    expect(ids['price-buddy']).toEqual(['au_other'])
    expect(await addBuddySchedule('inbox-buddy', 'whenever')).toEqual({
      ok: false,
      error: 'I could not read that time.'
    })
    expect(await addBuddySchedule('nobody', 'every day at 8')).toMatchObject({ ok: false })
  })

  it('removes only its own schedule', async () => {
    await addBuddySchedule('inbox-buddy', 'every day at 8')
    expect(removeBuddySchedule('inbox-buddy', 'au_other')).toBe(false)
    expect(removeBuddySchedule('inbox-buddy', 'au_n0')).toBe(true)
    expect(ids['inbox-buddy']).toEqual([])
  })

  it('replaces the schedule for buddy creation (T51), or removes it', async () => {
    await addBuddySchedule('inbox-buddy', 'every day at 8')
    const r = await replaceBuddySchedule('inbox-buddy', {
      trigger: { kind: 'daily', at: '09:00' },
      description: 'every day at 09:00'
    })
    expect(r).toEqual({ ok: true, text: 'It runs every day at 09:00.' })
    expect(
      list.filter((a) => a.action.kind === 'buddy' && a.action.buddyId === 'inbox-buddy')
    ).toHaveLength(1)
    expect(await replaceBuddySchedule('inbox-buddy', null)).toEqual({
      ok: true,
      text: 'It no longer runs on a schedule.'
    })
    expect(ids['inbox-buddy']).toEqual([])
  })
})

describe('BuddyPauseFlag', () => {
  it('persists the flag', () => {
    const t = tempDir()
    try {
      const file = join(t.dir, 'buddies-state.json')
      const f = new BuddyPauseFlag(file)
      expect(f.get()).toBe(false)
      f.set(true)
      expect(new BuddyPauseFlag(file).get()).toBe(true)
    } finally {
      t.cleanup()
    }
  })
})
