// Buddies IPC (08 T52) for Home and Settings (T53): list with next runs, one buddy with its
// schedules, run now, stop, on / off, pause all, delete, run history, schedules, the notebook;
// `buddies:changed` goes to the Home and panel windows after bus `buddies.changed` (and when a
// buddy's task starts or ends). The handler table takes its ports, so it is tested without
// Electron.
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { AutomationView } from '@shared/automations'
import type { Buddy, BuddyRunSummary, BuddySummary } from '@shared/buddies'
import type {
  BuddiesView,
  BuddyDetail,
  BuddyRunResult,
  BuddyScheduleView
} from '@shared/buddy-views'
import {
  buddyEnableSchema,
  buddyIdSchema,
  buddyNotebookSetSchema,
  buddyRunSchema,
  buddyScheduleAddSchema,
  buddyScheduleRemoveSchema
} from '@shared/ipc'
import { notice } from '../agent-mode/background'
import { bus } from '../bus'
import { INVALID, safeParse } from '../ipc/validate'
import { automations, automationsLoaded } from '../routines'
import * as home from '../windows/home'
import * as panel from '../windows/settings'
import {
  buddiesPaused,
  buddyOnScreen,
  setBuddiesPaused,
  startBuddyNow,
  stopBuddy,
  type CallOutcome
} from './calling'
import {
  buddyNotebook,
  buddyRuns,
  buddySummaries,
  getBuddy,
  removeBuddy,
  setBuddyEnabled,
  setBuddyNotebook
} from './index'
import {
  addBuddySchedule,
  removeBuddySchedule,
  removeBuddySchedules,
  type ScheduleAddResult
} from './schedule'
import type { NotebookWrite } from './store'

export interface BuddiesIpcDeps {
  summaries(): BuddySummary[]
  get(id: string): Buddy | null
  /** Automations with action buddy (empty before they load). */
  schedules(): AutomationView[]
  onScreen(): string | null
  start(id: string, text?: string): CallOutcome
  stop(id: string): number
  setEnabled(id: string, enabled: boolean): boolean
  pausedAll(): boolean
  setPausedAll(paused: boolean): void
  remove(id: string): boolean
  runs(id: string): BuddyRunSummary[]
  addSchedule(
    id: string,
    when: string,
    opts: { prompt?: string; wake?: boolean }
  ): Promise<ScheduleAddResult>
  removeSchedule(id: string, automationId: string): boolean
  notebook(id: string): string
  setNotebook(id: string, text: string): NotebookWrite
  /** Spoken / shown when a foreground run started from Settings ends. */
  finished?(name: string, text: string): void
}

const NOTEBOOK_ERRORS: Record<Exclude<NotebookWrite, 'ok'>, string> = {
  disabled: 'Memory is off or private mode is on, so the notebook cannot be saved.',
  rejected: 'That looks like a password or other secret; it was not saved.',
  'too-long': 'The notebook keeps at most 8 KB. Make it shorter.',
  missing: 'There is no such buddy.'
}

function scheduleViews(list: AutomationView[], id: string): BuddyScheduleView[] {
  return list
    .filter((a) => a.action.kind === 'buddy' && a.action.buddyId === id)
    .map((a) => ({
      automationId: a.id,
      triggerText: a.triggerText,
      enabled: a.enabled,
      ...(a.nextRunAt !== undefined ? { nextRunAt: a.nextRunAt } : {}),
      ...(a.wake ? { wake: true } : {}),
      ...(a.action.kind === 'buddy' && a.action.prompt ? { prompt: a.action.prompt } : {})
    }))
}

const nextOf = (s: BuddyScheduleView[]): number | undefined =>
  s.reduce<number | undefined>(
    (n, x) =>
      x.enabled && x.nextRunAt !== undefined
        ? n === undefined
          ? x.nextRunAt
          : Math.min(n, x.nextRunAt)
        : n,
    undefined
  )

const idArg = (channel: string, raw: unknown): string | undefined =>
  safeParse(channel, buddyIdSchema, raw)

type Handler = (...args: unknown[]) => unknown

/** The handlers by channel; each validates its payload (invalid → E_INVALID). */
export function buddiesIpcHandlers(d: BuddiesIpcDeps): Record<string, Handler> {
  return {
    'buddies:list': (...args): BuddiesView | typeof INVALID => {
      if (args.length) return INVALID
      const all = d.schedules()
      const fg = d.onScreen()
      return {
        pausedAll: d.pausedAll(),
        buddies: d.summaries().map((s) => {
          const next = s.enabled ? nextOf(scheduleViews(all, s.id)) : undefined
          return { ...s, onScreen: fg === s.id, ...(next !== undefined ? { nextRunAt: next } : {}) }
        })
      }
    },
    'buddies:get': (raw): BuddyDetail | null | typeof INVALID => {
      const id = idArg('buddies:get', raw)
      if (id === undefined) return INVALID
      const buddy = d.get(id)
      if (!buddy) return null
      const running = d.summaries().find((s) => s.id === id)?.running ?? false
      return {
        buddy,
        schedules: scheduleViews(d.schedules(), id),
        running,
        onScreen: d.onScreen() === id
      }
    },
    'buddies:run': (raw): BuddyRunResult | typeof INVALID => {
      const r = safeParse('buddies:run', buddyRunSchema, raw)
      if (!r) return INVALID
      const out = d.start(r.id, r.text || undefined)
      if (!out.ok) return { ok: false, error: out.error }
      if (out.lane === 'background') return { ok: true, taskId: out.task.id }
      const name = d.get(r.id)?.name ?? 'The buddy'
      void out.response.then(
        (res) => {
          const v = res as { spoken?: string; text?: string }
          d.finished?.(name, v.spoken || v.text || '')
        },
        (e: Error) => d.finished?.(name, e.name === 'AbortError' ? 'Stopped.' : e.message)
      )
      return { ok: true, onScreen: true }
    },
    'buddies:stop': (raw) => {
      const id = idArg('buddies:stop', raw)
      if (id === undefined) return INVALID
      const stopped = d.stop(id)
      return { ok: stopped > 0, stopped }
    },
    'buddies:set-enabled': (raw) => {
      const r = safeParse('buddies:set-enabled', buddyEnableSchema, raw)
      if (!r) return INVALID
      return { ok: d.setEnabled(r.id, r.enabled) }
    },
    'buddies:pause-all': (raw) => {
      const paused = safeParse('buddies:pause-all', z.boolean(), raw)
      if (paused === undefined) return INVALID
      d.setPausedAll(paused)
      return { ok: true }
    },
    'buddies:remove': (raw) => {
      const id = idArg('buddies:remove', raw)
      if (id === undefined) return INVALID
      d.stop(id)
      return { ok: d.remove(id) }
    },
    'buddies:runs': (raw) => {
      const id = idArg('buddies:runs', raw)
      if (id === undefined) return INVALID
      return d.runs(id)
    },
    'buddies:schedule-add': async (raw) => {
      const r = safeParse('buddies:schedule-add', buddyScheduleAddSchema, raw)
      if (!r) return INVALID
      const out = await d.addSchedule(r.id, r.when, {
        ...(r.prompt ? { prompt: r.prompt } : {}),
        ...(r.wake ? { wake: true } : {})
      })
      return out.ok ? { ok: true, automationId: out.automationId } : { ok: false, error: out.error }
    },
    'buddies:schedule-remove': (raw) => {
      const r = safeParse('buddies:schedule-remove', buddyScheduleRemoveSchema, raw)
      if (!r) return INVALID
      return { ok: d.removeSchedule(r.id, r.automationId) }
    },
    'buddies:notebook-get': (raw) => {
      const id = idArg('buddies:notebook-get', raw)
      if (id === undefined) return INVALID
      return d.notebook(id)
    },
    'buddies:notebook-set': (raw) => {
      const r = safeParse('buddies:notebook-set', buddyNotebookSetSchema, raw)
      if (!r) return INVALID
      const w = d.setNotebook(r.id, r.text)
      return w === 'ok' ? { ok: true } : { ok: false, error: NOTEBOOK_ERRORS[w] }
    }
  }
}

const PUSH_MS = 150

let registered = false

export function registerBuddiesIpc(): void {
  if (registered) return
  registered = true
  const handlers = buddiesIpcHandlers({
    summaries: buddySummaries,
    get: getBuddy,
    schedules: () => (automationsLoaded() ? automations().list() : []),
    onScreen: buddyOnScreen,
    start: (id, text) =>
      startBuddyNow(id, { trigger: 'manual', ...(text ? { utterance: text } : {}) }),
    stop: stopBuddy,
    setEnabled: (id, enabled) => !!setBuddyEnabled(id, enabled),
    pausedAll: buddiesPaused,
    setPausedAll: setBuddiesPaused,
    remove: (id) => {
      const ok = removeBuddy(id)
      if (ok) removeBuddySchedules(id)
      return ok
    },
    runs: (id) => buddyRuns(id),
    addSchedule: addBuddySchedule,
    removeSchedule: removeBuddySchedule,
    notebook: buddyNotebook,
    setNotebook: setBuddyNotebook,
    finished: (name, text) => notice(text ? `${name}: ${text}` : `${name} is done.`)
  })
  for (const [channel, fn] of Object.entries(handlers))
    ipcMain.handle(channel, (_e, ...args: unknown[]) => fn(...args))

  // One push per burst: Home's strip and Settings re-read `buddies:list`.
  let timer: NodeJS.Timeout | null = null
  const ids = new Set<string>()
  const changed = (list: readonly string[]): void => {
    for (const id of list) ids.add(id)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const out = [...ids]
      ids.clear()
      home.send('buddies:changed', out)
      panel.send('buddies:changed', out)
    }, PUSH_MS)
  }
  bus.on('buddies.changed', (e) => changed(e.ids))
  bus.on('buddy.working', (e) => changed([e.buddyId]))
  // A buddy's task started, ended or moved on (running state, last result).
  const phases = new Map<string, string>()
  bus.on('task.changed', (e) => {
    const t = e.task
    if (!t.buddyId || t.parentId || phases.get(t.id) === t.phase) return
    phases.set(t.id, t.phase)
    if (phases.size > 200) phases.delete(phases.keys().next().value as string)
    changed([t.buddyId])
  })
}
