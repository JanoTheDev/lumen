// Background task lifecycle (CONTRACTS C11): queue (max N running, FIFO after that), cancel,
// queued questions, results, unseen count and interrupted-on-quit. The actual run (model,
// tools) is injected, so this file has no Electron and no providers.
import type { BackgroundArtifact, BackgroundTask, BackgroundTaskPhase } from '@shared/types'
import type { RunEvent } from '../transcript'
import { currentUsageScope, runInUsageScope, type UsageScope } from '../../usage/scope'
import { taskUsageScope } from '../../usage/task-scope'

export const MAX_PROGRESS = 20
export const KEEP_TASKS = 50
const TITLE_MAX = 60
/** Steer messages waiting for the task's next step. */
export const MAX_STEERS = 10
export const STEER_MAX = 2000

export interface StartInput {
  prompt: string
  /** The user's own words when `prompt` holds more (policy userText); default the prompt. */
  userText?: string
  title?: string
  skill?: string
  origin: BackgroundTask['origin']
  /** spawn_task child of this task. */
  parentId?: string
  /** A routine's run. */
  routineId?: string
  /** A buddy's run (08 T50; origin buddy). */
  buddyId?: string
  /** Skip the queue (a parent waits on it: queueing could deadlock the slots). */
  immediate?: boolean
  /**
   * The task's own runner in place of ManagerDeps.run (a Claude Code session). It brings its
   * own caps, starts at once, takes no slot and cannot be run again.
   */
  run?: (ctl: TaskControl) => Promise<RunOutcome>
  claude?: BackgroundTask['claude']
}

export interface TaskControl {
  task(): BackgroundTask
  signal: AbortSignal
  update(patch: Partial<BackgroundTask>): void
  progress(line: string): void
  /**
   * A queued question: the task waits (phase asking) until the user answers in the list.
   * Questions asked at once (parallel sub-agents) wait in line, shown one at a time. `signal`
   * withdraws the question when the caller stops waiting (a job's own time limit).
   */
  ask(
    text: string,
    choices?: string[],
    phase?: 'asking' | 'needs-foreground',
    signal?: AbortSignal
  ): Promise<string>
  /** Before each model turn: waits while paused, then hands over the user's steer messages. */
  between?(signal: AbortSignal): Promise<string[]>
  /** Waits while the task is paused (its sub-agents, between their turns). */
  hold?(signal: AbortSignal): Promise<void>
  /** The runner's transcript events (model text, tool calls, results). */
  record?(e: RunEvent): void
}

/** What the task's transcript hears from the manager (08 T43). */
export type TaskRecord =
  | { type: 'start'; task: BackgroundTask }
  | { type: 'run'; ev: RunEvent }
  | { type: 'question'; text: string; choices?: string[] }
  | { type: 'answer'; text: string }
  | { type: 'steer'; text: string }
  | { type: 'paused' | 'resumed' }
  /** Steer messages the task never read (it ended before its next model turn). */
  | { type: 'unread'; texts: string[] }
  | { type: 'end'; task: BackgroundTask }

export interface RunOutcome {
  status: 'done' | 'failed'
  summary: string
  report?: string
  artifacts?: BackgroundArtifact[]
  /** present_cards: the card set ("View results"). */
  cardsId?: string
}

export interface ManagerDeps {
  /** Max running at once (config agent.background.max). */
  max(): number
  run(ctl: TaskControl): Promise<RunOutcome>
  emit(task: BackgroundTask): void
  save?(task: BackgroundTask): void
  remove?(id: string): void
  /** A task ended (done / failed): the presence-gated notice. */
  finished?(task: BackgroundTask): void
  /** The task's transcript (08 T43). */
  record?(id: string, e: TaskRecord): void
  /**
   * Why a new run may not start (monthly usage limits, 05 T45), else null. Checked for every
   * start, "Run again" included; a refused run ends at once with the reason.
   */
  refuse?(input: StartInput): string | null
  /**
   * "Run again" of a task that is rebuilt from where it came from (a buddy's run from the buddy
   * as it is now): its start input, null to refuse (the buddy is off or gone), undefined to
   * repeat the task as it was.
   */
  rerun?(task: BackgroundTask): StartInput | null | undefined
  now(): number
  newId(): string
}

interface Ask {
  text: string
  choices?: string[]
  phase: 'asking' | 'needs-foreground'
  resolve(answer: string): void
}

interface Entry {
  task: BackgroundTask
  run?: (ctl: TaskControl) => Promise<RunOutcome>
  ac?: AbortController
  /** Open questions, oldest first; the first one is shown. */
  asks: Ask[]
  done: Promise<BackgroundTask>
  resolveDone: (t: BackgroundTask) => void
  steers: string[]
  paused?: boolean
  /** Waiters held while paused (the task and its sub-agents). */
  wakers: Set<() => void>
  /** The usage scope the run records under, fixed at start (05 T43). */
  scope?: UsageScope
  /** Refused at start (monthly limits): ended at once, may still be run again. */
  refused?: boolean
}

const ACTIVE: BackgroundTaskPhase[] = ['running', 'asking', 'needs-foreground']
const OPEN: BackgroundTaskPhase[] = [...ACTIVE, 'queued']

export function isActive(t: BackgroundTask): boolean {
  return ACTIVE.includes(t.phase)
}

export function isOpen(t: BackgroundTask): boolean {
  return OPEN.includes(t.phase)
}

/** "check the price of the lamp every hour" → "Check the price of the lamp every hour". */
export function taskTitle(prompt: string): string {
  const t = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
  const cut = t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…` : t
  return cut.charAt(0).toUpperCase() + cut.slice(1)
}

export class BackgroundManager {
  private entries = new Map<string, Entry>()
  private queue: string[] = []

  constructor(private readonly deps: ManagerDeps) {}

  list(): BackgroundTask[] {
    return [...this.entries.values()]
      .map((e) => e.task)
      .sort((a, b) => b.counters.startedAt - a.counters.startedAt || (a.id < b.id ? 1 : -1))
  }

  get(id: string): BackgroundTask | null {
    return this.entries.get(id)?.task ?? null
  }

  running(): number {
    let n = 0
    for (const e of this.entries.values()) if (isActive(e.task)) n++
    return n
  }

  /** Running tasks that hold a slot (own-runner tasks do not). */
  private slotted(): number {
    let n = 0
    for (const e of this.entries.values()) if (!e.run && isActive(e.task)) n++
    return n
  }

  unseenCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.task.unseen) n++
    return n
  }

  childCount(parentId: string): number {
    let n = 0
    for (const e of this.entries.values()) if (e.task.parentId === parentId) n++
    return n
  }

  /** Persisted tasks from earlier sessions (open ones become interrupted). */
  restore(tasks: BackgroundTask[]): void {
    for (const t of tasks) {
      if (this.entries.has(t.id)) continue
      const task: BackgroundTask = isOpen(t)
        ? { ...t, phase: 'interrupted', question: undefined }
        : t
      const entry = this.newEntry(task)
      entry.resolveDone(task)
      if (task !== t) this.deps.save?.(task)
    }
    this.prune()
  }

  start(input: StartInput): BackgroundTask {
    const refused = input.run ? null : (this.deps.refuse?.(input) ?? null)
    if (refused) input = { ...input, run: async () => ({ status: 'failed', summary: refused }) }
    const task: BackgroundTask = {
      id: this.deps.newId(),
      title: input.title?.trim() || taskTitle(input.prompt),
      prompt: input.prompt,
      ...(input.userText !== undefined ? { userText: input.userText } : {}),
      ...(input.skill ? { skill: input.skill } : {}),
      origin: input.origin,
      phase: 'queued',
      progress: [],
      counters: { modelCalls: 0, costUsd: 0, startedAt: this.deps.now() },
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.buddyId ? { buddyId: input.buddyId } : {}),
      ...(input.claude ? { claude: input.claude } : {})
    }
    const entry = this.newEntry(task)
    entry.scope = taskUsageScope(task, this.parentScope(input.parentId))
    if (input.run) entry.run = input.run
    if (refused) entry.refused = true
    this.deps.record?.(task.id, { type: 'start', task })
    this.changed(task.id)
    if (input.immediate || input.run || this.slotted() < this.deps.max()) this.launch(task.id)
    else this.queue.push(task.id)
    this.prune()
    return this.entries.get(task.id)!.task
  }

  /** Resolves with the task once it ended (done, failed, cancelled or interrupted). */
  wait(id: string): Promise<BackgroundTask> {
    const e = this.entries.get(id)
    return e ? e.done : Promise.reject(new Error(`no task ${id}`))
  }

  cancel(id: string): boolean {
    const e = this.entries.get(id)
    if (!e || !isOpen(e.task)) return false
    for (const c of this.entries.values())
      if (c.task.parentId === id && isOpen(c.task)) this.cancel(c.task.id)
    if (e.task.phase === 'queued') {
      this.queue = this.queue.filter((q) => q !== id)
      this.end(id, { phase: 'cancelled' })
      return true
    }
    e.ac?.abort()
    return true
  }

  /** Answers the task's shown question; the next one in line is shown then. */
  answer(id: string, text: string): boolean {
    const e = this.entries.get(id)
    const a = e?.asks[0]
    if (!e || !a || !text.trim()) return false
    e.asks.shift()
    this.deps.record?.(id, { type: 'answer', text: text.trim() })
    this.showAsk(id)
    a.resolve(text.trim())
    return true
  }

  /**
   * A message from the user for the task's next step (the chat view, "tell the task to …").
   * Own-runner tasks (Claude sessions) take messages their own way.
   */
  steer(id: string, text: string): boolean {
    const e = this.entries.get(id)
    const t = text.replace(/\s+/g, ' ').trim().slice(0, STEER_MAX)
    if (!e || e.run || !isOpen(e.task) || !t || e.steers.length >= MAX_STEERS) return false
    e.steers.push(t)
    this.deps.record?.(id, { type: 'steer', text: t })
    return true
  }

  /** Holds the task before its next model turn (a running tool call finishes first). */
  pause(id: string): boolean {
    const e = this.entries.get(id)
    if (!e || e.run || e.paused || !isActive(e.task)) return false
    e.paused = true
    this.deps.record?.(id, { type: 'paused' })
    this.note(id, 'Paused')
    return true
  }

  resume(id: string): boolean {
    const e = this.entries.get(id)
    if (!e?.paused) return false
    e.paused = false
    for (const w of [...e.wakers]) w()
    this.deps.record?.(id, { type: 'resumed' })
    this.note(id, 'Going on')
    return true
  }

  isPaused(id: string): boolean {
    return !!this.entries.get(id)?.paused
  }

  /** Can take steer messages (not a Claude session's own runner). */
  steerable(id: string): boolean {
    const e = this.entries.get(id)
    return !!e && !e.run && isOpen(e.task)
  }

  markSeen(id?: string): void {
    for (const e of this.entries.values()) {
      if (!e.task.unseen || (id && e.task.id !== id)) continue
      this.patch(e.task.id, { unseen: false })
    }
  }

  runAgain(id: string): BackgroundTask | null {
    const t = this.get(id)
    const e = this.entries.get(id)
    if (!t || isOpen(t) || t.claude || (e?.run && !e.refused)) return null
    const rebuilt = this.deps.rerun?.(t)
    if (rebuilt === null) return null
    if (rebuilt) return this.start(rebuilt)
    return this.start({
      prompt: t.prompt,
      ...(t.userText !== undefined ? { userText: t.userText } : {}),
      title: t.title,
      skill: t.skill,
      origin: t.origin,
      routineId: t.routineId,
      ...(t.buddyId ? { buddyId: t.buddyId } : {})
    })
  }

  /** On quit: every open task becomes interrupted (no resume after a restart). */
  interruptAll(): void {
    this.queue = []
    for (const e of this.entries.values()) {
      if (!isOpen(e.task)) continue
      e.ac?.abort()
      this.end(e.task.id, { phase: 'interrupted', question: undefined })
    }
  }

  // ---- internals ----

  /**
   * A helper's parent scope: the parent background task's, or the foreground task whose run is
   * starting it (only when the running scope is that very task).
   */
  private parentScope(parentId?: string): UsageScope | undefined {
    if (!parentId) return undefined
    const own = this.entries.get(parentId)?.scope
    if (own) return own
    const now = currentUsageScope()
    return now.taskId === parentId ? now : undefined
  }

  private newEntry(task: BackgroundTask): Entry {
    let resolveDone!: (t: BackgroundTask) => void
    const done = new Promise<BackgroundTask>((r) => (resolveDone = r))
    const entry: Entry = { task, done, resolveDone, steers: [], asks: [], wakers: new Set() }
    this.entries.set(task.id, entry)
    return entry
  }

  private changed(id: string): void {
    const t = this.entries.get(id)?.task
    if (!t) return
    this.deps.save?.(t)
    this.deps.emit(t)
  }

  private patch(id: string, p: Partial<BackgroundTask>): void {
    const e = this.entries.get(id)
    if (!e) return
    e.task = { ...e.task, ...p }
    this.changed(id)
  }

  /** Shows the first open question, or goes back to running when none is left. */
  private showAsk(id: string): void {
    const e = this.entries.get(id)
    if (!e || !isOpen(e.task)) return
    const a = e.asks[0]
    if (!a) return this.patch(id, { phase: 'running', question: undefined })
    this.deps.record?.(id, { type: 'question', text: a.text, choices: a.choices })
    this.patch(id, {
      phase: a.phase,
      question: { text: a.text, ...(a.choices?.length ? { choices: a.choices } : {}) }
    })
  }

  /** A progress line from the manager itself (paused, going on). */
  private note(id: string, line: string): void {
    const t = this.entries.get(id)?.task
    if (t) this.patch(id, { progress: [...t.progress, line].slice(-MAX_PROGRESS) })
  }

  private end(id: string, p: Partial<BackgroundTask>): void {
    const e = this.entries.get(id)
    if (!e || !isOpen(e.task)) return
    e.asks = []
    e.paused = false
    for (const w of [...e.wakers]) w()
    if (e.steers.length) this.deps.record?.(id, { type: 'unread', texts: e.steers })
    e.steers = []
    this.patch(id, { ...p, endedAt: this.deps.now() })
    this.deps.record?.(id, { type: 'end', task: e.task })
    e.resolveDone(e.task)
    this.prune()
  }

  private launch(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    const ac = new AbortController()
    e.ac = ac
    this.patch(id, {
      phase: 'running',
      counters: { ...e.task.counters, startedAt: this.deps.now() }
    })
    // Several waiters (the task and its sub-agents) may hold at once: resume wakes them all.
    const hold = async (signal: AbortSignal): Promise<void> => {
      while (e.paused && !signal.aborted)
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            e.wakers.delete(wake)
            signal.removeEventListener('abort', wake)
            resolve()
          }
          e.wakers.add(wake)
          signal.addEventListener('abort', wake, { once: true })
        })
    }
    const ctl: TaskControl = {
      hold,
      task: () => this.entries.get(id)!.task,
      signal: ac.signal,
      update: (p) => {
        if (!ac.signal.aborted) this.patch(id, p)
      },
      progress: (line) => {
        if (ac.signal.aborted) return
        const t = this.entries.get(id)!.task
        const text = line.replace(/\s+/g, ' ').trim().slice(0, 160)
        if (!text || t.progress[t.progress.length - 1] === text) return
        this.patch(id, { progress: [...t.progress, text].slice(-MAX_PROGRESS) })
      },
      ask: (text, choices, phase = 'asking', signal) =>
        new Promise<string>((resolve, reject) => {
          if (ac.signal.aborted) return reject(ac.signal.reason)
          if (signal?.aborted) return reject(signal.reason)
          const stop = (): void => {
            ac.signal.removeEventListener('abort', onAbort)
            signal?.removeEventListener('abort', onWithdraw)
          }
          const onAbort = (): void => {
            stop()
            reject(ac.signal.reason)
          }
          // The caller stopped waiting: take the question out of the line.
          const onWithdraw = (): void => {
            stop()
            const at = e.asks.indexOf(ask)
            if (at >= 0) e.asks.splice(at, 1)
            if (at === 0) this.showAsk(id)
            reject(signal?.reason)
          }
          const ask: Ask = {
            text,
            ...(choices?.length ? { choices: choices.slice(0, 4) } : {}),
            phase,
            resolve: (answer) => {
              stop()
              resolve(answer)
            }
          }
          ac.signal.addEventListener('abort', onAbort, { once: true })
          signal?.addEventListener('abort', onWithdraw, { once: true })
          e.asks.push(ask)
          if (e.asks.length === 1) this.showAsk(id)
        }),
      between: async (signal) => {
        await hold(signal)
        const notes = e.steers
        e.steers = []
        return notes
      },
      record: (ev) => {
        if (!ac.signal.aborted) this.deps.record?.(id, { type: 'run', ev })
      }
    }
    const run = e.run ?? ((c: TaskControl) => this.deps.run(c))
    void runInUsageScope(e.scope ?? taskUsageScope(e.task), () => run(ctl))
      .then(
        (r) => {
          if (ac.signal.aborted) return this.end(id, { phase: 'cancelled' })
          this.end(id, {
            phase: r.status,
            question: undefined,
            unseen: true,
            result: {
              summary: r.summary,
              ...(r.report ? { report: r.report } : {}),
              ...(r.artifacts?.length ? { artifacts: r.artifacts } : {}),
              ...(r.cardsId ? { cardsId: r.cardsId } : {})
            }
          })
        },
        (err: unknown) => {
          if (ac.signal.aborted) return this.end(id, { phase: 'cancelled', question: undefined })
          this.end(id, {
            phase: 'failed',
            question: undefined,
            unseen: true,
            result: { summary: `It failed: ${(err as Error)?.message ?? String(err)}` }
          })
        }
      )
      .finally(() => {
        const t = this.entries.get(id)?.task
        if (t && (t.phase === 'done' || t.phase === 'failed')) this.deps.finished?.(t)
        this.pump()
      })
  }

  private pump(): void {
    while (this.queue.length && this.slotted() < this.deps.max()) {
      const next = this.queue.shift()!
      if (this.entries.get(next)?.task.phase === 'queued') this.launch(next)
    }
  }

  private prune(): void {
    const ended = this.list().filter((t) => !isOpen(t))
    for (const t of ended.slice(KEEP_TASKS)) {
      this.entries.delete(t.id)
      this.deps.remove?.(t.id)
    }
  }
}
