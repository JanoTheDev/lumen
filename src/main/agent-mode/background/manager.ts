// Background task lifecycle (CONTRACTS C11): queue (max N running, FIFO after that), cancel,
// queued questions, results, unseen count and interrupted-on-quit. The actual run (model,
// tools) is injected, so this file has no Electron and no providers.
import type { BackgroundArtifact, BackgroundTask, BackgroundTaskPhase } from '@shared/types'

export const MAX_PROGRESS = 20
export const KEEP_TASKS = 50
const TITLE_MAX = 60

export interface StartInput {
  prompt: string
  title?: string
  skill?: string
  origin: BackgroundTask['origin']
  /** spawn_task child of this task. */
  parentId?: string
  /** Skip the queue (a parent waits on it: queueing could deadlock the slots). */
  immediate?: boolean
}

export interface TaskControl {
  task(): BackgroundTask
  signal: AbortSignal
  update(patch: Partial<BackgroundTask>): void
  progress(line: string): void
  /** A queued question: the task waits (phase asking) until the user answers in the list. */
  ask(text: string, choices?: string[], phase?: 'asking' | 'needs-foreground'): Promise<string>
}

export interface RunOutcome {
  status: 'done' | 'failed'
  summary: string
  report?: string
  artifacts?: BackgroundArtifact[]
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
  now(): number
  newId(): string
}

interface Entry {
  task: BackgroundTask
  ac?: AbortController
  answer?: (text: string) => void
  done: Promise<BackgroundTask>
  resolveDone: (t: BackgroundTask) => void
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
    const task: BackgroundTask = {
      id: this.deps.newId(),
      title: input.title?.trim() || taskTitle(input.prompt),
      prompt: input.prompt,
      ...(input.skill ? { skill: input.skill } : {}),
      origin: input.origin,
      phase: 'queued',
      progress: [],
      counters: { modelCalls: 0, costUsd: 0, startedAt: this.deps.now() },
      ...(input.parentId ? { parentId: input.parentId } : {})
    }
    this.newEntry(task)
    this.changed(task.id)
    if (input.immediate || this.running() < this.deps.max()) this.launch(task.id)
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

  /** Answers the task's queued question. */
  answer(id: string, text: string): boolean {
    const e = this.entries.get(id)
    const a = e?.answer
    if (!e || !a || !text.trim()) return false
    e.answer = undefined
    this.patch(id, { phase: 'running', question: undefined })
    a(text.trim())
    return true
  }

  markSeen(id?: string): void {
    for (const e of this.entries.values()) {
      if (!e.task.unseen || (id && e.task.id !== id)) continue
      this.patch(e.task.id, { unseen: false })
    }
  }

  runAgain(id: string): BackgroundTask | null {
    const t = this.get(id)
    if (!t || isOpen(t)) return null
    return this.start({ prompt: t.prompt, title: t.title, skill: t.skill, origin: t.origin })
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

  private newEntry(task: BackgroundTask): Entry {
    let resolveDone!: (t: BackgroundTask) => void
    const done = new Promise<BackgroundTask>((r) => (resolveDone = r))
    const entry: Entry = { task, done, resolveDone }
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

  private end(id: string, p: Partial<BackgroundTask>): void {
    const e = this.entries.get(id)
    if (!e || !isOpen(e.task)) return
    e.answer = undefined
    this.patch(id, { ...p, endedAt: this.deps.now() })
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
    const ctl: TaskControl = {
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
      ask: (text, choices, phase = 'asking') =>
        new Promise<string>((resolve, reject) => {
          if (ac.signal.aborted) return reject(ac.signal.reason)
          const onAbort = (): void => reject(ac.signal.reason)
          ac.signal.addEventListener('abort', onAbort, { once: true })
          e.answer = (answer) => {
            ac.signal.removeEventListener('abort', onAbort)
            resolve(answer)
          }
          this.patch(id, {
            phase,
            question: { text, ...(choices?.length ? { choices: choices.slice(0, 4) } : {}) }
          })
        })
    }
    void this.deps
      .run(ctl)
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
              ...(r.artifacts?.length ? { artifacts: r.artifacts } : {})
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
    while (this.queue.length && this.running() < this.deps.max()) {
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
