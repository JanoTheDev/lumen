// Task chat hub (08 T41): one transcript recorder per task id, saved a moment after it changes
// (and at once when the task ends), pushed live only to views that watch that id. Background
// tasks report through the manager (TaskRecord), foreground agent tasks through session.ts,
// Claude sessions through the CLI's stream. Electron-free; the header comes from a source the
// wiring sets (transcript-wire.ts).
import type { AgentTask } from '@shared/events'
import type { ClaudeSessionView } from '@shared/claude-code'
import type { ChatDelta, ChatHeader, ChatPhase, ChatView } from '@shared/task-chat'
import type { BackgroundTask } from '@shared/types'
import type { TaskRecord } from './background/manager'
import { taskTitle } from './background/manager'
import { applyClaudeEvent, applyClaudeUser, applyClaudeView } from './transcript-claude'
import { TranscriptRecorder, type ChatMeta, type TranscriptData } from './transcript'
import type { TranscriptStore } from './transcript-store'

export const SAVE_DELAY_MS = 1000
const MAX_STEERS = 10

type Watcher = (d: ChatDelta) => void

const FG_PHASE: Record<AgentTask['phase'], ChatPhase> = {
  planning: 'running',
  countdown: 'running',
  running: 'running',
  confirm: 'confirm',
  asking: 'asking',
  paused: 'paused',
  done: 'done',
  failed: 'failed',
  aborted: 'cancelled'
}

export interface HubDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
}

const DEFAULT_DEPS: HubDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout)
}

export class TranscriptHub {
  private recs = new Map<string, TranscriptRecorder>()
  private timers = new Map<string, unknown>()
  private watchers = new Map<string, Set<Watcher>>()
  private steers = new Map<string, string[]>()
  /** Background task ids that belong to a Claude session (their transcript is the session's). */
  private claudeTasks = new Set<string>()
  private store: TranscriptStore | null = null
  private header: (id: string) => ChatHeader | null = () => null

  constructor(private readonly deps: HubDeps = DEFAULT_DEPS) {}

  setStore(store: TranscriptStore | null): void {
    this.store = store
  }

  setHeaderSource(fn: (id: string) => ChatHeader | null): void {
    this.header = fn
  }

  /** The recorder for `id` (loaded from disk the first time, or new). */
  rec(id: string): TranscriptRecorder {
    let r = this.recs.get(id)
    if (r) return r
    const data = this.store?.load(id) ?? undefined
    r = new TranscriptRecorder(
      id,
      {
        now: () => this.deps.now(),
        onEntry: (e) => {
          this.push(id, { id, entries: [e] })
          this.saveSoon(id)
        }
      },
      data
    )
    this.recs.set(id, r)
    return r
  }

  has(id: string): boolean {
    return this.recs.has(id) || !!this.store?.load(id)
  }

  view(id: string): ChatView | null {
    const header = this.header(id)
    if (!header) return null
    const r = this.rec(id)
    return { header, entries: [...r.entries], dropped: r.dropped }
  }

  /** Metas of foreground and Claude transcripts (the view's task list). */
  metas(): { id: string; meta: ChatMeta }[] {
    const out = new Map<string, ChatMeta>()
    for (const id of this.store?.ids() ?? []) {
      if (id.startsWith('bg_')) continue
      const meta = this.recs.get(id)?.meta ?? this.store?.load(id)?.meta
      if (meta) out.set(id, meta)
    }
    for (const [id, r] of this.recs) if (!id.startsWith('bg_') && r.meta) out.set(id, r.meta)
    return [...out].map(([id, meta]) => ({ id, meta }))
  }

  meta(id: string): ChatMeta | undefined {
    return this.recs.get(id)?.meta ?? this.store?.load(id)?.meta
  }

  // ---- live view ----

  watch(id: string, fn: Watcher): () => void {
    let set = this.watchers.get(id)
    if (!set) this.watchers.set(id, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) this.watchers.delete(id)
    }
  }

  watched(id: string): boolean {
    return !!this.watchers.get(id)?.size
  }

  /** The header changed (task state, counters): pushed to an open view. */
  touch(id: string): void {
    if (!this.watched(id)) return
    const header = this.header(id)
    if (header) this.push(id, { id, header })
  }

  private push(id: string, d: ChatDelta): void {
    for (const fn of this.watchers.get(id) ?? []) {
      try {
        fn(d)
      } catch {
        /* a closed view */
      }
    }
  }

  // ---- persistence ----

  private saveSoon(id: string): void {
    if (!this.store || this.timers.has(id)) return
    this.timers.set(
      id,
      this.deps.setTimer(() => this.flush(id), SAVE_DELAY_MS)
    )
  }

  flush(id: string): void {
    const t = this.timers.get(id)
    if (t !== undefined) this.deps.clearTimer(t)
    this.timers.delete(id)
    const r = this.recs.get(id)
    if (r && this.store) this.store.save(r.data())
  }

  flushAll(): void {
    for (const id of [...this.recs.keys()]) this.flush(id)
  }

  remove(id: string): void {
    const t = this.timers.get(id)
    if (t !== undefined) this.deps.clearTimer(t)
    this.timers.delete(id)
    this.recs.delete(id)
    this.steers.delete(id)
    this.claudeTasks.delete(id)
    this.store?.remove(id)
  }

  // ---- background tasks (BackgroundManager.record) ----

  background(id: string, e: TaskRecord): void {
    if (e.type === 'start' && e.task.claude) this.claudeTasks.add(id)
    if (this.claudeTasks.has(id)) {
      if (e.type === 'end') this.claudeTasks.delete(id)
      return
    }
    const r = this.rec(id)
    switch (e.type) {
      case 'start':
        if (!r.entries.length) r.user(e.task.prompt)
        break
      case 'run':
        r.run(e.ev)
        break
      case 'question':
        r.question(e.text, e.choices)
        break
      case 'answer':
        r.answer(e.text)
        break
      case 'steer':
        r.user(e.text, true)
        break
      case 'paused':
        r.status('Paused. It goes on when you press Resume.')
        break
      case 'resumed':
        r.status('Going on.')
        break
      case 'end':
        endBackground(r, e.task)
        this.flush(id)
        break
    }
  }

  // ---- foreground agent tasks (session.ts) ----

  foregroundStart(id: string, prompt: string): void {
    const r = this.rec(id)
    if (!r.entries.length) r.user(prompt)
    r.meta = {
      kind: 'foreground',
      title: taskTitle(prompt),
      phase: 'running',
      startedAt: r.meta?.startedAt ?? this.deps.now(),
      modelCalls: r.meta?.modelCalls ?? 0,
      costUsd: r.meta?.costUsd ?? 0
    }
    this.touch(id)
  }

  foregroundTask(task: AgentTask): void {
    const r = this.recs.get(task.id)
    if (!r?.meta) return
    const phase = FG_PHASE[task.phase]
    const m = r.meta
    if (task.question?.text) r.question(task.question.text, task.question.choices)
    if (
      m.phase !== phase ||
      m.modelCalls !== task.counters.modelCalls ||
      m.costUsd !== task.counters.costUsd
    ) {
      r.meta = { ...m, phase, modelCalls: task.counters.modelCalls, costUsd: task.counters.costUsd }
      this.saveSoon(task.id)
      this.touch(task.id)
    }
  }

  foregroundEnd(
    id: string,
    end:
      | { status: 'done' | 'failed' | 'stopped' | 'paused'; summary: string; report?: string }
      | { error: string; cancelled: boolean }
  ): void {
    const r = this.recs.get(id)
    if (!r) return
    r.closeOpen()
    this.steers.delete(id)
    let phase: ChatPhase
    if ('error' in end) {
      phase = end.cancelled ? 'cancelled' : 'failed'
      if (end.cancelled) r.status('Stopped.')
      else r.error(end.error)
    } else if (end.status === 'paused') {
      phase = 'paused'
      r.status(end.summary)
    } else {
      phase = end.status === 'done' ? 'done' : 'failed'
      r.result(end.summary, end.status === 'done', end.report)
    }
    if (r.meta)
      r.meta = { ...r.meta, phase, ...(phase === 'paused' ? {} : { endedAt: this.deps.now() }) }
    this.flush(id)
    this.touch(id)
  }

  // ---- steer messages for the foreground task (the manager keeps background ones) ----

  steer(id: string, text: string): boolean {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 2000)
    const q = this.steers.get(id) ?? []
    if (!t || q.length >= MAX_STEERS) return false
    this.steers.set(id, [...q, t])
    this.rec(id).user(t, true)
    return true
  }

  drain(id: string): string[] {
    const q = this.steers.get(id) ?? []
    this.steers.delete(id)
    return q
  }

  // ---- Claude Code sessions ----

  claudeUser(v: ClaudeSessionView | null, id: string, text: string): void {
    applyClaudeUser(this.rec(id), text, v, this.deps.now())
  }

  claudeEvent(id: string, ev: Record<string, unknown>): void {
    applyClaudeEvent(this.rec(id), ev)
  }

  claudeView(v: ClaudeSessionView): void {
    const r = this.rec(v.id)
    const before = r.meta
    applyClaudeView(r, v)
    const m = r.meta
    if (
      !before ||
      before.phase !== m?.phase ||
      before.costUsd !== m?.costUsd ||
      before.title !== m?.title
    ) {
      this.saveSoon(v.id)
      this.touch(v.id)
    }
  }
}

function endBackground(r: TranscriptRecorder, t: BackgroundTask): void {
  r.closeOpen()
  switch (t.phase) {
    case 'done':
    case 'failed':
      r.result(t.result?.summary ?? '', t.phase === 'done', t.result?.report)
      break
    case 'cancelled':
      r.status('Cancelled.')
      break
    case 'interrupted':
      r.status('Stopped when Lumen closed.')
      break
  }
}

let hub: TranscriptHub | null = null

/** The app's hub. */
export function transcripts(): TranscriptHub {
  return (hub ??= new TranscriptHub())
}

export type { TranscriptData }
