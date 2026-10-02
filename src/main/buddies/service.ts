// The buddies service (08 T50): the store, runs as background tasks, run history from the task
// list and the hook the background runner asks for a buddy task's settings. Electron-free: the
// background manager, envelope builder and spend reader come in as ports (index.ts wires them).
import type { Buddy, BuddyRunSummary, BuddySummary } from '@shared/buddies'
import type { BackgroundTask } from '@shared/types'
import type { BuddyRunHook } from '../agent-mode/background/buddy-hook'
import { isOpen, type StartInput } from '../agent-mode/background/manager'
import { withUsageScope } from '../usage/scope'
import { buddyNameKey, isBuddyId, safeBuddyName } from './clamp'
import {
  buddyPromptUtterance,
  buddyStartInput,
  buddyTaskEnv,
  BuddyRunBudgets,
  type EnvelopeFor,
  type RunBuddyOpts
} from './run'
import type { BuddyStore, NotebookWrite } from './store'

/** This month's spend of one buddy (05 T45 usage ledger); null = not known. */
export type BuddySpendReader = (
  buddyId: string,
  now: Date
) => { usd: number; tokens: number } | null

export type RunBuddyResult =
  | { ok: true; task: BackgroundTask }
  | { ok: false; code: 'E_NOT_FOUND' | 'E_OFF' | 'E_BUDGET' | 'E_BUSY'; error: string }

export interface BuddiesDeps {
  store: BuddyStore
  start(input: StartInput): BackgroundTask
  /** Every background task the manager knows (restored ones included). */
  tasks(): BackgroundTask[]
  /** `buddies.changed` on the bus. */
  emit(ids: string[]): void
  envelope: EnvelopeFor
  spend?(): BuddySpendReader | null
  now?(): number
}

const SUMMARY_MAX = 300

function runSummary(t: BackgroundTask): BuddyRunSummary {
  return {
    taskId: t.id,
    title: t.title,
    phase: t.phase,
    startedAt: t.counters.startedAt,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    ...(t.result?.summary ? { summary: t.result.summary.slice(0, SUMMARY_MAX) } : {}),
    costUsd: t.counters.costUsd
  }
}

/** Why a buddy may not start another run this month; null when it may. */
export function overBudget(b: Buddy, spent: { usd: number; tokens: number } | null): string | null {
  if (!spent) return null
  if (b.budget.perMonthUsd !== undefined && spent.usd >= b.budget.perMonthUsd)
    return `${b.name} used its budget for this month ($${b.budget.perMonthUsd.toFixed(2)}).`
  if (b.budget.perMonthTokens !== undefined && spent.tokens >= b.budget.perMonthTokens)
    return `${b.name} used its tokens for this month.`
  return null
}

/** A buddy's on-screen runs (08 T52), newest first; `running` while one is open. */
export type ScreenRunsReader = (buddyId: string) => BuddyRunSummary[]

/**
 * The buddy is busy on screen: its foreground run is starting or running (`onScreen`, set
 * before the run's row exists), or its newest on-screen run is paused and still resumable.
 */
export function screenRunBusy(
  id: string,
  now: { onScreen: string | null; newest?: BuddyRunSummary; pausedHeld: boolean }
): boolean {
  if (now.onScreen === id) return true
  return !!now.newest && now.newest.phase === 'paused' && now.pausedHeld
}

const newestFirst = (a: BuddyRunSummary, b: BuddyRunSummary): number => b.startedAt - a.startedAt

export class Buddies {
  private screenRuns: ScreenRunsReader = () => []
  private screenBusy: (id: string) => boolean = () => false
  private readonly budgets = new BuddyRunBudgets(() => this.deps.tasks())

  constructor(private readonly deps: BuddiesDeps) {}

  /** Where the buddy's on-screen runs come from (calling.ts sets it). */
  setScreenRuns(read: ScreenRunsReader, busy?: (id: string) => boolean): void {
    this.screenRuns = read
    if (busy) this.screenBusy = busy
  }

  /** Background runs and on-screen runs, newest first. */
  private allRuns(id: string, tasks: BackgroundTask[]): BuddyRunSummary[] {
    const own = tasks.filter((t) => t.buddyId === id && !t.parentId).map(runSummary)
    return [...own, ...this.screenRuns(id)].sort(newestFirst)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  list(): Buddy[] {
    return this.deps.store.list()
  }

  get(id: string): Buddy | null {
    return this.deps.store.get(id)
  }

  /** The buddy's folder is there (readable or not): not deleted. */
  exists(id: string): boolean {
    return this.deps.store.hasFolder(id)
  }

  /** A name match, case and spacing ignored ("inbox buddy" → Inbox Buddy). */
  byName(name: string): Buddy | null {
    const want = buddyNameKey(name)
    return want ? (this.list().find((b) => buddyNameKey(b.name) === want) ?? null) : null
  }

  /**
   * A run of the buddy is queued or running (in the background or on screen, starting or
   * paused there too).
   */
  isRunning(id: string): boolean {
    const open = this.deps.tasks().some((t) => t.buddyId === id && !t.parentId && isOpen(t))
    return open || this.screenBusy(id) || this.screenRuns(id).some((r) => r.phase === 'running')
  }

  summaries(): BuddySummary[] {
    const tasks = this.deps.tasks()
    return this.list().map((b) => {
      const own = tasks.filter((t) => t.buddyId === b.id && !t.parentId)
      const last = this.allRuns(b.id, tasks)[0]
      return {
        id: b.id,
        name: b.name,
        look: b.look,
        description: (b.instructions.split('\n')[0] ?? '').slice(0, 160),
        model: b.model,
        report: b.report,
        trust: b.trust,
        enabled: b.enabled,
        scheduleIds: b.scheduleIds,
        running: own.some(isOpen) || this.screenRuns(b.id).some((r) => r.phase === 'running'),
        ...(last ? { lastRun: last } : {})
      }
    })
  }

  /** A new buddy of the user's own (clamped; trust mine). */
  create(fields: Partial<Omit<Buddy, 'id'>> & { name: string }): Buddy {
    const b = this.deps.store.create(fields)
    this.deps.emit([b.id])
    return b
  }

  /**
   * Changes fields (clamped). The id, trust and createdAt never change here: an imported buddy
   * becomes the user's own only through T51's trust flow.
   */
  update(id: string, patch: Partial<Omit<Buddy, 'id' | 'trust' | 'createdAt'>>): Buddy | null {
    const b = this.get(id)
    if (!b) return null
    // Names stay unique: a rename to another buddy's name is refused.
    if (patch.name !== undefined) {
      const name = safeBuddyName(patch.name.replace(/\s+/g, ' ').trim())
      if (buddyNameKey(name) !== buddyNameKey(b.name) && this.deps.store.nameTaken(name, id))
        throw new Error(`You already have a buddy called ${name}.`)
    }
    const next = this.deps.store.save({
      ...b,
      ...patch,
      id: b.id,
      trust: b.trust,
      createdAt: b.createdAt
    })
    this.deps.emit([id])
    return next
  }

  setEnabled(id: string, enabled: boolean): Buddy | null {
    return this.update(id, { enabled })
  }

  remove(id: string): boolean {
    const ok = this.deps.store.remove(id)
    if (ok) this.deps.emit([id])
    return ok
  }

  notebook(id: string): string {
    return this.deps.store.readNotebook(id)
  }

  setNotebook(id: string, text: string): NotebookWrite {
    const r = this.deps.store.writeNotebook(id, text)
    if (r === 'ok') this.deps.emit([id])
    return r
  }

  /** memory_write of a run: one note appended to the buddy's notebook. */
  appendNotebook(id: string, fact: string): 'ok' | 'rejected' | 'disabled' {
    const r = this.deps.store.appendNotebook(id, fact)
    if (r === 'ok') this.deps.emit([id])
    return r === 'ok' || r === 'disabled' ? r : 'rejected'
  }

  /** Starts the buddy now as a background task (origin buddy). */
  run(id: string, opts: RunBuddyOpts): RunBuddyResult {
    const b = isBuddyId(id) ? this.get(id) : null
    if (!b) return { ok: false, code: 'E_NOT_FOUND', error: 'There is no such buddy.' }
    if (!b.enabled) return { ok: false, code: 'E_OFF', error: `${b.name} is turned off.` }
    const over = overBudget(b, this.deps.spend?.()?.(b.id, new Date(this.now())) ?? null)
    if (over) return { ok: false, code: 'E_BUDGET', error: over }
    // One run at a time: a second call or schedule never doubles the work and the spend.
    if (this.isRunning(b.id))
      return { ok: false, code: 'E_BUSY', error: `${b.name} is already working on it.` }
    const task = this.deps.start(buddyStartInput(b, opts))
    this.deps.emit([b.id])
    return { ok: true, task }
  }

  /** The buddy's runs, on screen ones too, newest first (helpers it spawned are left out). */
  runs(id: string, limit = 20): BuddyRunSummary[] {
    return this.allRuns(id, this.deps.tasks()).slice(0, limit)
  }

  /** What the background runner asks for a buddy task. */
  hook(): BuddyRunHook {
    return {
      forTask: (task, host) => {
        const b = task.buddyId ? this.get(task.buddyId) : null
        if (!b) return 'This buddy was deleted.'
        if (!b.enabled) return `${b.name} is turned off.`
        const env = buddyTaskEnv(b, task, host, {
          envelope: this.deps.envelope,
          notebook: this.notebook(b.id),
          memoryWrite: (fact) => this.appendNotebook(b.id, fact),
          // The run and its helpers spend from one budget, not a budget each.
          budget: this.budgets.for(b, task)
        })
        return env
      },
      scope: (task, fn) =>
        withUsageScope({ origin: 'buddy', buddyId: task.buddyId, taskId: task.id }, fn),
      silent: (task) => (task.buddyId ? this.get(task.buddyId)?.report === 'silent' : false),
      rerun: (task) => {
        const b = task.buddyId && isBuddyId(task.buddyId) ? this.get(task.buddyId) : null
        if (!b || !b.enabled || this.isRunning(b.id)) return null
        const utterance = buddyPromptUtterance(task.prompt)
        return buddyStartInput(b, {
          trigger: 'manual',
          ...(utterance ? { utterance } : {}),
          ...(task.routineId ? { automationId: task.routineId } : {})
        })
      }
    }
  }
}
