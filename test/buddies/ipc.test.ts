// Buddies IPC (08 T52): every payload validated, list rows with next runs, schedules per buddy,
// run now (background or on screen), notebook errors in words, and the buddies:changed push.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationView } from '@shared/automations'
import type { Buddy, BuddySummary } from '@shared/buddies'
import type { BackgroundTask } from '@shared/types'

const h = vi.hoisted(() => ({
  homeSend: vi.fn(),
  panelSend: vi.fn(),
  handlers: new Map<string, (...a: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn)
  }
}))
vi.mock('../../src/main/windows/home', () => ({ send: h.homeSend }))
vi.mock('../../src/main/windows/settings', () => ({ send: h.panelSend }))
vi.mock('../../src/main/agent-mode/background', () => ({ notice: vi.fn() }))
vi.mock('../../src/main/routines', () => ({
  automations: () => ({ list: () => [] }),
  automationsLoaded: () => true
}))
vi.mock('../../src/main/buddies/calling', () => ({
  buddiesPaused: () => false,
  buddyOnScreen: () => null,
  setBuddiesPaused: vi.fn(),
  startBuddyNow: vi.fn(),
  stopBuddy: vi.fn(() => 0)
}))
vi.mock('../../src/main/buddies/index', () => ({
  buddyNotebook: () => '',
  buddyRuns: () => [],
  buddySummaries: () => [],
  getBuddy: () => null,
  removeBuddy: () => false,
  setBuddyEnabled: () => null,
  setBuddyNotebook: () => 'missing'
}))
vi.mock('../../src/main/buddies/schedule', () => ({
  addBuddySchedule: vi.fn(),
  removeBuddySchedule: vi.fn(),
  removeBuddySchedules: vi.fn()
}))

import { bus } from '../../src/main/bus'
import {
  buddiesIpcHandlers,
  registerBuddiesIpc,
  type BuddiesIpcDeps
} from '../../src/main/buddies/ipc'

const INVALID = { error: 'E_INVALID' }

const summary = (p: Partial<BuddySummary>): BuddySummary => ({
  id: 'inbox-buddy',
  name: 'Inbox Buddy',
  look: { color: '#5b8def', initial: 'I' },
  description: '',
  model: 'fast',
  report: 'notify',
  trust: 'mine',
  enabled: true,
  scheduleIds: ['au_a', 'au_b'],
  running: false,
  ...p
})

const view = (id: string, buddyId: string, p: Partial<AutomationView> = {}): AutomationView => ({
  id,
  name: 'x',
  trigger: { kind: 'daily', at: '08:00' },
  action: { kind: 'buddy', buddyId },
  preApproved: [],
  enabled: true,
  failures: 0,
  createdAt: 0,
  triggerText: 'every day at 08:00',
  actionText: 'run it',
  running: false,
  ...p
})

function deps(p: Partial<BuddiesIpcDeps> = {}): BuddiesIpcDeps {
  return {
    summaries: () => [
      summary({}),
      summary({ id: 'price-buddy', name: 'Price Buddy', scheduleIds: [] })
    ],
    get: (id) => (id === 'inbox-buddy' ? ({ id, name: 'Inbox Buddy' } as Buddy) : null),
    schedules: () => [
      view('au_a', 'inbox-buddy', { nextRunAt: 5000 }),
      view('au_b', 'inbox-buddy', {
        nextRunAt: 3000,
        action: { kind: 'buddy', buddyId: 'inbox-buddy', prompt: 'brief' }
      }),
      view('au_c', 'inbox-buddy', { nextRunAt: 1000, enabled: false }),
      view('au_d', 'price-buddy', { action: { kind: 'task', prompt: 'x' } })
    ],
    onScreen: () => 'price-buddy',
    start: vi.fn(() => ({
      ok: true as const,
      lane: 'background' as const,
      task: { id: 'bg_1' } as BackgroundTask
    })),
    stop: vi.fn(() => 1),
    setEnabled: vi.fn(() => true),
    pausedAll: () => true,
    setPausedAll: vi.fn(),
    remove: vi.fn(() => true),
    runs: () => [],
    addSchedule: vi.fn(async () => ({ ok: true as const, automationId: 'au_new' })),
    removeSchedule: vi.fn(() => true),
    notebook: () => 'notes',
    setNotebook: vi.fn(() => 'too-long' as const),
    ...p
  }
}

describe('buddies IPC handlers', () => {
  it('rejects bad payloads', async () => {
    const t = buddiesIpcHandlers(deps())
    expect(t['buddies:list']('extra')).toEqual(INVALID)
    expect(t['buddies:get']('../etc')).toEqual(INVALID)
    expect(t['buddies:run']({ id: 'inbox-buddy', extra: 1 })).toEqual(INVALID)
    expect(t['buddies:set-enabled']({ id: 'inbox-buddy' })).toEqual(INVALID)
    expect(t['buddies:pause-all']('yes')).toEqual(INVALID)
    expect(await t['buddies:schedule-add']({ id: 'inbox-buddy', when: '' })).toEqual(INVALID)
    expect(t['buddies:schedule-remove']({ id: 'inbox-buddy', automationId: 'a b' })).toEqual(
      INVALID
    )
    expect(t['buddies:notebook-set']({ id: 'inbox-buddy' })).toEqual(INVALID)
  })

  it('lists buddies with their next run, on-screen state and the pause flag', () => {
    const v = buddiesIpcHandlers(deps())['buddies:list']() as {
      pausedAll: boolean
      buddies: { id: string; nextRunAt?: number; onScreen: boolean }[]
    }
    expect(v.pausedAll).toBe(true)
    expect(v.buddies.map((b) => [b.id, b.nextRunAt, b.onScreen])).toEqual([
      ['inbox-buddy', 3000, false],
      ['price-buddy', undefined, true]
    ])
  })

  it('gets one buddy with its schedules', () => {
    const t = buddiesIpcHandlers(deps())
    expect(t['buddies:get']('price-x')).toBeNull()
    expect(t['buddies:get']('inbox-buddy')).toMatchObject({
      buddy: { id: 'inbox-buddy' },
      running: false,
      onScreen: false,
      schedules: [
        { automationId: 'au_a', nextRunAt: 5000 },
        { automationId: 'au_b', prompt: 'brief' },
        { automationId: 'au_c', enabled: false }
      ]
    })
  })

  it('runs now in the background or on screen', async () => {
    const d = deps()
    const t = buddiesIpcHandlers(d)
    expect(t['buddies:run']({ id: 'inbox-buddy', text: 'check Outlook' })).toEqual({
      ok: true,
      taskId: 'bg_1'
    })
    expect(d.start).toHaveBeenCalledWith('inbox-buddy', 'check Outlook')
    const finished = vi.fn()
    const fg = buddiesIpcHandlers(
      deps({
        finished,
        start: () => ({
          ok: true,
          lane: 'foreground',
          response: Promise.resolve({ mode: 'answer', text: 'Filed 3 receipts.' })
        })
      })
    )
    expect(fg['buddies:run']({ id: 'inbox-buddy' })).toEqual({ ok: true, onScreen: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toHaveBeenCalledWith('Inbox Buddy', 'Filed 3 receipts.')
    const off = buddiesIpcHandlers(
      deps({ start: () => ({ ok: false, code: 'E_OFF', error: 'Inbox Buddy is turned off.' }) })
    )
    expect(off['buddies:run']({ id: 'inbox-buddy' })).toEqual({
      ok: false,
      error: 'Inbox Buddy is turned off.'
    })
  })

  it('stop, on/off, pause all, remove, schedules and the notebook', async () => {
    const d = deps()
    const t = buddiesIpcHandlers(d)
    expect(t['buddies:stop']('inbox-buddy')).toEqual({ ok: true, stopped: 1 })
    expect(t['buddies:set-enabled']({ id: 'inbox-buddy', enabled: false })).toEqual({ ok: true })
    expect(d.setEnabled).toHaveBeenCalledWith('inbox-buddy', false)
    expect(t['buddies:pause-all'](false)).toEqual({ ok: true })
    expect(d.setPausedAll).toHaveBeenCalledWith(false)
    expect(t['buddies:remove']('inbox-buddy')).toEqual({ ok: true })
    expect(
      await t['buddies:schedule-add']({ id: 'inbox-buddy', when: 'every weekday at 8', wake: true })
    ).toEqual({ ok: true, automationId: 'au_new' })
    expect(d.addSchedule).toHaveBeenCalledWith('inbox-buddy', 'every weekday at 8', { wake: true })
    expect(t['buddies:schedule-remove']({ id: 'inbox-buddy', automationId: 'au_a' })).toEqual({
      ok: true
    })
    expect(t['buddies:notebook-get']('inbox-buddy')).toBe('notes')
    expect(t['buddies:notebook-set']({ id: 'inbox-buddy', text: 'x' })).toEqual({
      ok: false,
      error: 'The notebook keeps at most 8 KB. Make it shorter.'
    })
  })
})

describe('buddies:changed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reaches Home and the panel once per burst, also for buddy task phases', () => {
    registerBuddiesIpc()
    expect(h.handlers.has('buddies:list')).toBe(true)
    expect(h.handlers.has('buddies:notebook-set')).toBe(true)
    bus.emit({ type: 'buddies.changed', ids: ['inbox-buddy'] })
    bus.emit({ type: 'buddy.working', buddyId: 'price-buddy', active: true })
    vi.advanceTimersByTime(200)
    expect(h.homeSend).toHaveBeenCalledTimes(1)
    expect(h.homeSend).toHaveBeenCalledWith('buddies:changed', ['inbox-buddy', 'price-buddy'])
    expect(h.panelSend).toHaveBeenCalledWith('buddies:changed', ['inbox-buddy', 'price-buddy'])
    h.homeSend.mockClear()
    const task = { id: 'bg_x1', buddyId: 'inbox-buddy', phase: 'running' } as BackgroundTask
    bus.emit({ type: 'task.changed', task })
    bus.emit({ type: 'task.changed', task })
    bus.emit({ type: 'task.changed', task: { ...task, id: 'bg_x2', buddyId: undefined } })
    vi.advanceTimersByTime(200)
    expect(h.homeSend).toHaveBeenCalledTimes(1)
    expect(h.homeSend).toHaveBeenCalledWith('buddies:changed', ['inbox-buddy'])
  })
})
