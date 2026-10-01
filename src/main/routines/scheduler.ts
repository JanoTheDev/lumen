// The routine scheduler: one timer for the next due routine, only while Lumen runs. A run is a
// background task (injected `run`); its end updates the failure counter, and 3 failures in a
// row turn the routine off with a notice. Nothing is caught up after Lumen was closed, and a
// daily run more than STALE_MS late (the PC slept) waits for its next day.
import type { Routine, RoutineSchedule, RoutineView } from '@shared/routines'
import { MAX_ROUTINES } from './store'
import { describeSchedule, nextRun } from './schedule'

export const MAX_FAILURES = 3
/** Longest single timer; the scheduler re-checks the clock at least this often. */
export const MAX_TIMER_MS = 60 * 60_000
/** A daily run this late (sleep, clock change) is skipped. */
export const STALE_MS = 30 * 60_000
/** An "every N minutes" routine whose turn passed while Lumen was closed starts this late. */
export const STARTUP_DELAY_MS = 60_000

export type RunResult = 'done' | 'failed' | 'cancelled'

export interface SchedulerDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Starts the routine as a background task and resolves when that task ended. */
  run(routine: Routine): Promise<RunResult>
  save(list: Routine[]): void
  /** A routine turned itself off after MAX_FAILURES failed runs. */
  disabled?(routine: Routine): void
  changed?(): void
  newId(): string
}

export interface NewRoutine {
  name: string
  prompt: string
  schedule: RoutineSchedule
  preApproved?: Routine['preApproved']
}

export class RoutineScheduler {
  private routines: Routine[] = []
  private due = new Map<string, number>()
  private running = new Set<string>()
  private timer: unknown = null
  private stopped = true

  constructor(private readonly deps: SchedulerDeps) {}

  start(list: Routine[]): void {
    this.routines = list.slice(0, MAX_ROUTINES)
    this.stopped = false
    const now = this.deps.now()
    for (const r of this.routines) this.plan(r, now, true)
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  list(): RoutineView[] {
    return this.routines.map((r) => ({
      ...r,
      preApproved: r.preApproved.map((s) => ({ ...s })),
      scheduleText: describeSchedule(r.schedule),
      ...(r.enabled && this.due.has(r.id) ? { nextRunAt: this.due.get(r.id) } : {})
    }))
  }

  get(id: string): Routine | null {
    return this.routines.find((r) => r.id === id) ?? null
  }

  add(input: NewRoutine): Routine | null {
    if (this.routines.length >= MAX_ROUTINES) return null
    const r: Routine = {
      id: this.deps.newId(),
      name: input.name.trim().slice(0, 80) || 'Routine',
      prompt: input.prompt.trim(),
      schedule: input.schedule,
      preApproved: input.preApproved ?? [],
      enabled: true,
      failures: 0,
      createdAt: this.deps.now()
    }
    this.routines.push(r)
    this.plan(r, this.deps.now(), false)
    this.commit()
    return r
  }

  update(id: string, patch: Partial<Pick<Routine, 'enabled' | 'name' | 'preApproved'>>): boolean {
    const i = this.routines.findIndex((r) => r.id === id)
    if (i < 0) return false
    const before = this.routines[i]
    const next: Routine = { ...before, ...patch }
    if (patch.enabled && !before.enabled) {
      // Turned back on: a fresh start.
      next.failures = 0
      delete next.disabledReason
    }
    this.routines[i] = next
    this.plan(next, this.deps.now(), false)
    this.commit()
    return true
  }

  remove(id: string): boolean {
    const before = this.routines.length
    this.routines = this.routines.filter((r) => r.id !== id)
    if (this.routines.length === before) return false
    this.due.delete(id)
    this.commit()
    return true
  }

  /** Runs it now (Settings "Run now"); the schedule stays as it is. */
  runNow(id: string): boolean {
    const r = this.get(id)
    if (!r || this.running.has(id)) return false
    this.trigger(r, this.deps.now())
    return true
  }

  // ---- internals ----

  private plan(r: Routine, now: number, startup: boolean): void {
    if (!r.enabled) {
      this.due.delete(r.id)
      return
    }
    const s = r.schedule
    if (s.kind === 'every' && startup && r.lastRunAt !== undefined) {
      const at = nextRun(s, r.lastRunAt)
      this.due.set(r.id, Math.max(at, now + STARTUP_DELAY_MS))
      return
    }
    this.due.set(r.id, nextRun(s, now))
  }

  private commit(): void {
    this.deps.save(this.routines)
    this.deps.changed?.()
    this.arm()
  }

  private arm(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (this.stopped) return
    let first = Infinity
    for (const r of this.routines) {
      const d = this.due.get(r.id)
      if (r.enabled && d !== undefined && d < first) first = d
    }
    if (first === Infinity) return
    const ms = Math.min(Math.max(first - this.deps.now(), 0), MAX_TIMER_MS)
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.fire()
    }, ms)
  }

  private fire(): void {
    const now = this.deps.now()
    for (const r of [...this.routines]) {
      const d = this.due.get(r.id)
      if (!r.enabled || d === undefined || d > now) continue
      if (r.schedule.kind === 'daily' && now - d > STALE_MS) {
        this.due.set(r.id, nextRun(r.schedule, now))
        continue
      }
      this.due.set(r.id, nextRun(r.schedule, now))
      // Still busy with the previous run: this turn is skipped.
      if (!this.running.has(r.id)) this.trigger(r, now)
    }
    this.arm()
  }

  private trigger(r: Routine, now: number): void {
    this.running.add(r.id)
    this.patch(r.id, { lastRunAt: now })
    this.deps.save(this.routines)
    this.deps.changed?.()
    let run: Promise<RunResult>
    try {
      run = this.deps.run(r)
    } catch {
      run = Promise.resolve('failed')
    }
    void run
      .catch((): RunResult => 'failed')
      .then((result) => {
        this.running.delete(r.id)
        this.record(r.id, result)
      })
  }

  private record(id: string, result: RunResult): void {
    const r = this.get(id)
    if (!r) return
    // A run the user cancelled is not the routine's failure.
    const failures = result === 'done' ? 0 : result === 'failed' ? r.failures + 1 : r.failures
    if (failures >= MAX_FAILURES && r.enabled) {
      const off = this.patch(id, {
        lastResult: result,
        failures,
        enabled: false,
        disabledReason: `Turned off after ${MAX_FAILURES} failed runs in a row.`
      })
      this.due.delete(id)
      this.commit()
      if (off) this.deps.disabled?.(off)
      return
    }
    this.patch(id, { lastResult: result, failures })
    this.commit()
  }

  private patch(id: string, p: Partial<Routine>): Routine | null {
    const i = this.routines.findIndex((r) => r.id === id)
    if (i < 0) return null
    this.routines[i] = { ...this.routines[i], ...p }
    return this.routines[i]
  }
}
