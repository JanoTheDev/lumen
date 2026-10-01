// The automation scheduler: one timer for the next due time trigger, only while Lumen runs; event
// triggers come in through fireEvent (watchers.ts) and wake runs through runWake (Task Scheduler
// started Lumen, or handed the run to the open Lumen). A run is a background task (injected
// `run`); 3 failures in a row turn the automation off with a notice. Runs missed while Lumen
// was closed are not caught up unless the automation asks for it (catchUp), and a time run more
// than STALE_MS late (the PC slept) waits for its next turn.
import type {
  Automation,
  AutomationAction,
  AutomationResult,
  AutomationRun,
  AutomationTrigger,
  AutomationView
} from '@shared/automations'
import { describeAction, describeTrigger, isTimeTrigger, nextFire } from './triggers'

export const MAX_AUTOMATIONS = 50
export const MAX_FAILURES = 3
export const KEEP_RUNS = 10
/** Longest single timer; the scheduler re-checks the clock at least this often. */
export const MAX_TIMER_MS = 60 * 60_000
/** A time run this late (sleep, clock change) is skipped. */
export const STALE_MS = 30 * 60_000
/** Runs Lumen starts on its own (startup triggers, catch-up, overdue "every") wait this long. */
export const STARTUP_DELAY_MS = 60_000
/** A time run this soon after the last one is the same run arriving twice (wake + timer). */
export const DEDUPE_MS = 5 * 60_000
/** An event automation runs at most this often per hour. */
export const EVENT_MAX_PER_HOUR = 12
/** Event details waiting while the automation is still busy. */
export const MAX_PENDING = 5

export type RunVia = AutomationRun['via']
export type RunResult = AutomationResult

export interface RunEnd {
  result: RunResult
  summary?: string
  taskId?: string
}

export interface EngineDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Starts the automation's action and resolves when it ended. */
  run(a: Automation, ctx: { via: RunVia; detail?: string }): Promise<RunEnd>
  save(list: Automation[]): void
  /** It turned itself off after MAX_FAILURES failed runs. */
  disabled?(a: Automation): void
  changed?(): void
  newId(): string
  /** Time triggers that Task Scheduler drives (wake on and registered): no in-process timer. */
  external?(a: Automation): boolean
}

export interface NewAutomation {
  name: string
  trigger: AutomationTrigger
  action: AutomationAction
  preApproved?: Automation['preApproved']
  wake?: boolean
  catchUp?: boolean
}

export type AutomationPatch = Partial<
  Pick<Automation, 'enabled' | 'name' | 'preApproved' | 'trigger' | 'action' | 'wake' | 'catchUp'>
>

export class AutomationScheduler {
  private items: Automation[] = []
  private due = new Map<string, { at: number; via: RunVia }>()
  private running = new Set<string>()
  private pending = new Map<string, (string | undefined)[]>()
  private recent = new Map<string, number[]>()
  private timer: unknown = null
  private stopped = true

  constructor(private readonly deps: EngineDeps) {}

  start(list: Automation[]): void {
    this.items = list.slice(0, MAX_AUTOMATIONS)
    this.stopped = false
    const now = this.deps.now()
    let dirty = false
    for (const a of [...this.items]) {
      if (!a.enabled) continue
      if (a.trigger.kind === 'startup') {
        this.due.set(a.id, { at: now + STARTUP_DELAY_MS, via: 'event' })
        continue
      }
      if (!isTimeTrigger(a.trigger)) continue
      const missed = this.missedAt(a, now)
      if (missed !== null && a.catchUp) {
        this.due.set(a.id, { at: now + STARTUP_DELAY_MS, via: 'catch-up' })
        continue
      }
      if (a.trigger.kind === 'once' && missed !== null) {
        // Its time passed while Lumen was closed: done, without running.
        this.patch(a.id, {
          enabled: false,
          runs: this.withRun(a, {
            at: now,
            result: 'skipped',
            via: 'time',
            summary: 'Missed while Lumen was closed.'
          })
        })
        dirty = true
        continue
      }
      this.plan(a, now, true)
    }
    if (dirty) this.deps.save(this.items)
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  all(): Automation[] {
    return this.items
  }

  list(problem?: (a: Automation) => string | undefined): AutomationView[] {
    const now = this.deps.now()
    return this.items.map((a) => {
      const due = this.due.get(a.id)?.at
      const next =
        a.enabled && isTimeTrigger(a.trigger)
          ? (due ?? (this.deps.external?.(a) ? nextFire(a.trigger, now) : null))
          : null
      const p = problem?.(a)
      return {
        ...a,
        preApproved: a.preApproved.map((s) => ({ ...s })),
        runs: (a.runs ?? []).map((r) => ({ ...r })),
        triggerText: describeTrigger(a.trigger),
        actionText: describeAction(a.action),
        running: this.running.has(a.id),
        ...(next !== null && next !== undefined ? { nextRunAt: next } : {}),
        ...(p ? { problem: p } : {})
      }
    })
  }

  get(id: string): Automation | null {
    return this.items.find((a) => a.id === id) ?? null
  }

  add(input: NewAutomation): Automation | null {
    if (this.items.length >= MAX_AUTOMATIONS) return null
    const a: Automation = {
      id: this.deps.newId(),
      name: input.name.trim().slice(0, 80) || 'Automation',
      trigger: input.trigger,
      action: input.action,
      preApproved: input.preApproved ?? [],
      enabled: true,
      failures: 0,
      createdAt: this.deps.now(),
      ...(input.wake ? { wake: true } : {}),
      ...(input.catchUp ? { catchUp: true } : {})
    }
    this.items.push(a)
    this.plan(a, this.deps.now(), false)
    this.commit()
    return a
  }

  update(id: string, patch: AutomationPatch): boolean {
    const i = this.items.findIndex((a) => a.id === id)
    if (i < 0) return false
    const before = this.items[i]
    const next: Automation = { ...before, ...patch }
    if (patch.enabled && !before.enabled) {
      // Turned back on: a fresh start.
      next.failures = 0
      delete next.disabledReason
    }
    this.items[i] = next
    this.plan(next, this.deps.now(), false)
    this.commit()
    return true
  }

  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((a) => a.id !== id)
    if (this.items.length === before) return false
    this.due.delete(id)
    this.pending.delete(id)
    this.commit()
    return true
  }

  /** Settings "Run now": the schedule stays as it is. */
  runNow(id: string): boolean {
    const a = this.get(id)
    if (!a || this.running.has(id)) return false
    this.trigger(a, 'manual')
    return true
  }

  /** Task Scheduler started this run (`--run-automation <id>`). */
  runWake(id: string): boolean {
    const a = this.get(id)
    if (!a || !a.enabled || this.running.has(id) || this.duplicate(a)) return false
    this.trigger(a, 'wake')
    return true
  }

  /** A watcher saw the automation's event (an app, a file, idle, online). */
  fireEvent(id: string, detail?: string): boolean {
    const a = this.get(id)
    if (!a || !a.enabled || isTimeTrigger(a.trigger)) return false
    if (this.running.has(id)) {
      const q = this.pending.get(id) ?? []
      if (q.length < MAX_PENDING && !q.includes(detail)) q.push(detail)
      this.pending.set(id, q)
      return true
    }
    const now = this.deps.now()
    const recent = (this.recent.get(id) ?? []).filter((t) => now - t < 60 * 60_000)
    if (recent.length >= EVENT_MAX_PER_HOUR) {
      this.recent.set(id, recent)
      return false
    }
    recent.push(now)
    this.recent.set(id, recent)
    this.trigger(a, 'event', detail)
    return true
  }

  /** Re-plans every time trigger (Task Scheduler registration changed). */
  replan(): void {
    const now = this.deps.now()
    for (const a of this.items) if (isTimeTrigger(a.trigger)) this.plan(a, now, false)
    this.arm()
  }

  // ---- internals ----

  /** The time run missed while Lumen was closed, if any (not for plain "every N minutes"). */
  private missedAt(a: Automation, now: number): number | null {
    const t = a.trigger
    if (t.kind === 'every' && !t.from) return null
    if (t.kind === 'once') return t.at <= now && (a.lastRunAt ?? 0) < t.at ? t.at : null
    const at = nextFire(t, a.lastRunAt ?? a.createdAt)
    return at !== null && at <= now ? at : null
  }

  private duplicate(a: Automation): boolean {
    return a.lastRunAt !== undefined && this.deps.now() - a.lastRunAt < DEDUPE_MS
  }

  private plan(a: Automation, now: number, startup: boolean): void {
    const t = a.trigger
    if (!a.enabled || !isTimeTrigger(t) || this.deps.external?.(a)) {
      // A startup run waiting for its delay stays planned.
      if (!(a.enabled && t.kind === 'startup' && this.due.has(a.id))) this.due.delete(a.id)
      return
    }
    if (t.kind === 'every' && !t.from && startup && a.lastRunAt !== undefined) {
      const at = a.lastRunAt + t.minutes * 60_000
      this.due.set(a.id, { at: Math.max(at, now + STARTUP_DELAY_MS), via: 'time' })
      return
    }
    const at = nextFire(t, now)
    if (at === null) this.due.delete(a.id)
    else this.due.set(a.id, { at, via: 'time' })
  }

  private commit(): void {
    this.deps.save(this.items)
    this.deps.changed?.()
    this.arm()
  }

  private arm(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (this.stopped) return
    let first = Infinity
    for (const a of this.items) {
      const d = this.due.get(a.id)
      if (a.enabled && d !== undefined && d.at < first) first = d.at
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
    let dirty = false
    for (const a of [...this.items]) {
      const d = this.due.get(a.id)
      if (!a.enabled || d === undefined || d.at > now) continue
      this.due.delete(a.id)
      if (d.via === 'event' || d.via === 'catch-up') {
        // Startup trigger / a missed run caught up once.
        if (d.via === 'catch-up') this.plan(a, now, false)
        if (d.via === 'catch-up' && this.duplicate(a)) continue
        if (!this.running.has(a.id)) this.trigger(a, d.via)
        continue
      }
      const late = now - d.at > STALE_MS
      if (a.trigger.kind === 'once') {
        if (late) {
          this.patch(a.id, {
            enabled: false,
            runs: this.withRun(a, {
              at: now,
              result: 'skipped',
              via: 'time',
              summary: 'The PC was asleep at that time.'
            })
          })
          dirty = true
          continue
        }
      } else {
        this.plan(a, now, false)
        if (late) continue
      }
      // Still busy with the previous run, or the wake task ran it already: this turn is skipped.
      if (!this.running.has(a.id) && !this.duplicate(a)) this.trigger(a, 'time')
    }
    if (dirty) this.commit()
    else this.arm()
  }

  private trigger(a: Automation, via: RunVia, detail?: string): void {
    const now = this.deps.now()
    this.running.add(a.id)
    // A one-off is done once it started.
    this.patch(a.id, {
      lastRunAt: now,
      ...(a.trigger.kind === 'once' && via !== 'manual' ? { enabled: false } : {})
    })
    if (a.trigger.kind === 'once') this.due.delete(a.id)
    this.deps.save(this.items)
    this.deps.changed?.()
    let run: Promise<RunEnd>
    try {
      run = this.deps.run(this.get(a.id) ?? a, { via, ...(detail !== undefined ? { detail } : {}) })
    } catch {
      run = Promise.resolve({ result: 'failed' })
    }
    void run
      .catch((): RunEnd => ({ result: 'failed' }))
      .then((end) => {
        this.running.delete(a.id)
        this.record(a.id, end, now, via)
        const q = this.pending.get(a.id)
        if (q?.length) {
          const next = q.shift()
          if (!q.length) this.pending.delete(a.id)
          const cur = this.get(a.id)
          if (cur?.enabled) this.trigger(cur, 'event', next)
        }
      })
  }

  private withRun(a: Automation, run: AutomationRun): AutomationRun[] {
    return [...(a.runs ?? []), run].slice(-KEEP_RUNS)
  }

  private record(id: string, end: RunEnd, at: number, via: RunVia): void {
    const a = this.get(id)
    if (!a) return
    const run: AutomationRun = {
      at,
      result: end.result,
      via,
      ...(end.summary ? { summary: end.summary.slice(0, 300) } : {}),
      ...(end.taskId ? { taskId: end.taskId } : {})
    }
    const runs = this.withRun(a, run)
    // A run the user cancelled is not the automation's failure.
    const failures =
      end.result === 'done' ? 0 : end.result === 'failed' ? a.failures + 1 : a.failures
    if (failures >= MAX_FAILURES && a.enabled) {
      const off = this.patch(id, {
        lastResult: end.result,
        failures,
        runs,
        enabled: false,
        disabledReason: `Turned off after ${MAX_FAILURES} failed runs in a row.`
      })
      this.due.delete(id)
      this.commit()
      if (off) this.deps.disabled?.(off)
      return
    }
    this.patch(id, { lastResult: end.result, failures, runs })
    this.commit()
  }

  private patch(id: string, p: Partial<Automation>): Automation | null {
    const i = this.items.findIndex((a) => a.id === id)
    if (i < 0) return null
    this.items[i] = { ...this.items[i], ...p }
    return this.items[i]
  }
}
