// Buddy schedules (08 T52): an automation whose action is `{kind: 'buddy', buddyId}` runs the
// buddy (trigger 'schedule'); Buddy.scheduleIds follows the automations list. "pause all
// buddies" sets a flag (~/.ai-overlay/buddies-state.json) that makes scheduled runs skip; a run
// past the buddy's monthly limit, or of a buddy that is off, is recorded as skipped (not a
// failure, so it never turns the automation off). Pre-approval as for routines: a scheduled run
// works on screen only when its automation pre-approved the mouse and keyboard and the user is
// at the PC (presence rule); otherwise it runs in the background, where a buddy never takes the
// screen. Pure apart from the injected ports and the state file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { Automation, AutomationTrigger } from '@shared/automations'
import type { Buddy } from '@shared/buddies'
import type { BackgroundTask } from '@shared/types'
import type { RunEnd } from '../routines/engine'
import type { RunBuddyOpts, RunBuddyResult } from './index'

export const SKIP_BUDGET = 'Paused: monthly limit.'
export const SKIP_PAUSED = 'Paused: all buddies are paused.'
export const SKIP_OFF = 'Paused: the buddy is turned off.'

/** The buddy an automation runs, if it is a buddy schedule. */
export function scheduledBuddy(a: Pick<Automation, 'action'>): string | null {
  return a.action.kind === 'buddy' ? a.action.buddyId : null
}

/** Each buddy's schedule ids, from the automations list (in list order). */
export function scheduleIdsByBuddy(list: readonly Automation[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of list) {
    const id = scheduledBuddy(a)
    if (id) out.set(id, [...(out.get(id) ?? []), a.id])
  }
  return out
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

/** The buddies whose scheduleIds differ from the automations list, with the right ids. */
export function scheduleIdChanges(
  buddies: readonly Pick<Buddy, 'id' | 'scheduleIds'>[],
  list: readonly Automation[]
): { id: string; scheduleIds: string[] }[] {
  const by = scheduleIdsByBuddy(list)
  return buddies
    .map((b) => ({ id: b.id, scheduleIds: by.get(b.id) ?? [] }))
    .filter((x, i) => !sameIds(buddies[i].scheduleIds, x.scheduleIds))
}

/** Automations of buddies that no longer exist (removed with their buddy). */
export function orphanSchedules(
  list: readonly Automation[],
  exists: (buddyId: string) => boolean
): string[] {
  return list
    .filter((a) => {
      const id = scheduledBuddy(a)
      return id !== null && !exists(id)
    })
    .map((a) => a.id)
}

// ---- the paused-all flag ----

export class BuddyPauseFlag {
  private paused: boolean | null = null

  constructor(private readonly file: string) {}

  get(): boolean {
    if (this.paused === null) {
      try {
        const raw = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}
        this.paused = raw?.pausedAll === true
      } catch {
        this.paused = false
      }
    }
    return this.paused
  }

  set(paused: boolean): void {
    this.paused = paused
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ pausedAll: paused }), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      /* kept in memory for this session */
    }
  }
}

// ---- a scheduled run ----

export interface ScheduledRunDeps {
  pausedAll(): boolean
  getBuddy(id: string): Buddy | null
  run(id: string, opts: RunBuddyOpts): RunBuddyResult
  wait(taskId: string): Promise<BackgroundTask>
  /**
   * The run on screen when the buddy needs it, the automation pre-approved the mouse and keyboard
   * and the user is present; null = run in the background.
   */
  foreground?(b: Buddy, a: Automation, opts: RunBuddyOpts): Promise<RunEnd> | null
  /** A line under the presence rule (once a month per buddy for the monthly limit). */
  notice(text: string): void
  now(): number
}

const monthKey = (now: number): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth()}`
}

/** Buddies told about their monthly limit this month. */
const toldBudget = new Map<string, string>()

export function resetBudgetNotices(): void {
  toldBudget.clear()
}

export async function runScheduledBuddy(
  a: Automation,
  ctx: { via: string; detail?: string },
  deps: ScheduledRunDeps
): Promise<RunEnd> {
  const id = scheduledBuddy(a)
  if (!id) return { result: 'failed', summary: 'Not a buddy schedule.' }
  if (deps.pausedAll()) return { result: 'skipped', summary: SKIP_PAUSED }
  const b = deps.getBuddy(id)
  if (!b) return { result: 'failed', summary: 'This buddy was deleted.' }
  if (!b.enabled) return { result: 'skipped', summary: SKIP_OFF }
  const prompt = a.action.kind === 'buddy' ? a.action.prompt?.trim() : undefined
  const opts: RunBuddyOpts = {
    trigger: 'schedule',
    ...(prompt ? { utterance: prompt } : {}),
    ...(ctx.detail ? { detail: ctx.detail } : {})
  }
  const fg = deps.foreground?.(b, a, opts)
  if (fg) return fg
  const r = deps.run(id, opts)
  if (!r.ok) {
    if (r.code === 'E_BUDGET') {
      const key = monthKey(deps.now())
      if (toldBudget.get(id) !== key) {
        toldBudget.set(id, key)
        deps.notice(`${r.error} Its scheduled runs wait until next month.`)
      }
      return { result: 'skipped', summary: SKIP_BUDGET }
    }
    if (r.code === 'E_OFF') return { result: 'skipped', summary: SKIP_OFF }
    return { result: 'failed', summary: r.error }
  }
  const end = await deps.wait(r.task.id)
  const result = end.phase === 'done' ? 'done' : end.phase === 'failed' ? 'failed' : 'cancelled'
  return {
    result,
    ...(end.result?.summary ? { summary: end.result.summary } : {}),
    taskId: r.task.id
  }
}

// ---- adding and removing schedules (T51 creation and T53 Settings use these) ----

export interface ScheduleHost {
  /** null while the automations list is not loaded yet. */
  automations(): Automation[] | null
  /** A new automation from a "when" phrase (routines' parser); a string: why not. */
  add(input: {
    name: string
    when: string | AutomationTrigger
    action: Automation['action']
    wake?: boolean
  }): Promise<Automation | string>
  remove(id: string): boolean
  buddies(): Buddy[]
  getBuddy(id: string): Buddy | null
  setScheduleIds(id: string, scheduleIds: string[]): void
}

let host: ScheduleHost | null = null

export function setScheduleHost(h: ScheduleHost | null): void {
  host = h
}

export type ScheduleAddResult = { ok: true; automationId: string } | { ok: false; error: string }

/**
 * Schedules a buddy: "every weekday at 8", "when a PDF lands in Downloads", "every hour between
 * 9 and 5" … `prompt` = extra words for these runs; `wake` = wake Lumen (time triggers,
 * installed build).
 */
export async function addBuddySchedule(
  buddyId: string,
  when: string | AutomationTrigger,
  opts: { prompt?: string; wake?: boolean } = {}
): Promise<ScheduleAddResult> {
  if (!host) return { ok: false, error: 'Automations are not loaded.' }
  const b = host.getBuddy(buddyId)
  if (!b) return { ok: false, error: 'There is no such buddy.' }
  const prompt = opts.prompt?.trim()
  const a = await host.add({
    name: b.name,
    when,
    action: { kind: 'buddy', buddyId, ...(prompt ? { prompt } : {}) },
    ...(opts.wake ? { wake: true } : {})
  })
  if (typeof a === 'string') return { ok: false, error: a }
  syncScheduleIds()
  return { ok: true, automationId: a.id }
}

/** Removes one of the buddy's schedules (only an automation that runs this buddy). */
export function removeBuddySchedule(buddyId: string, automationId: string): boolean {
  if (!host) return false
  const a = host.automations()?.find((x) => x.id === automationId)
  if (!a || scheduledBuddy(a) !== buddyId) return false
  const ok = host.remove(automationId)
  if (ok) syncScheduleIds()
  return ok
}

/** Removes every schedule of a buddy (it was deleted). */
export function removeBuddySchedules(buddyId: string): number {
  if (!host) return 0
  let n = 0
  for (const a of host.automations() ?? [])
    if (scheduledBuddy(a) === buddyId && host.remove(a.id)) n++
  return n
}

/** Brings each buddy's scheduleIds in line with the automations list. */
export function syncScheduleIds(): void {
  if (!host) return
  const list = host.automations()
  if (!list) return
  for (const c of scheduleIdChanges(host.buddies(), list)) host.setScheduleIds(c.id, c.scheduleIds)
}

/**
 * T51's scheduler port: the buddy's schedule becomes this one (its earlier schedules removed),
 * or none (null). The line says what happens now.
 */
export async function replaceBuddySchedule(
  buddyId: string,
  schedule: { trigger: AutomationTrigger; description: string } | null
): Promise<{ ok: boolean; text: string }> {
  if (!host) return { ok: false, text: 'Automations are not loaded, so it has no schedule yet.' }
  const before = (host.automations() ?? []).filter((a) => scheduledBuddy(a) === buddyId)
  if (!schedule) {
    for (const a of before) host.remove(a.id)
    syncScheduleIds()
    return { ok: true, text: before.length ? 'It no longer runs on a schedule.' : '' }
  }
  const r = await addBuddySchedule(buddyId, schedule.trigger)
  if (!r.ok) return { ok: false, text: `I could not schedule it: ${r.error}` }
  for (const a of before) host.remove(a.id)
  syncScheduleIds()
  return { ok: true, text: `It runs ${schedule.description}.` }
}
