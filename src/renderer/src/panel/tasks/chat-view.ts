// Task chat view (08 T43): pure helpers for the panel's #/tasks/<id> page: deltas, grouping
// of tool rows, status words and what the screen reader hears for a new entry.
import type {
  ChatDelta,
  ChatEntry,
  ChatHeader,
  ChatPhase,
  ChatSummary,
  ChatView,
  JobStep,
  SubJob,
  ToolStatus
} from '@shared/task-chat'

/** Runs of at least this many tool rows fold into one "N steps" row. */
export const GROUP_MIN = 4

export function applyDelta(view: ChatView | null, d: ChatDelta): ChatView | null {
  if (!view || view.header.id !== d.id) return view
  let entries = view.entries
  if (d.entries?.length) {
    entries = [...entries]
    for (const e of d.entries) {
      const i = entries.findIndex((x) => x.n === e.n)
      if (i >= 0) entries[i] = e
      else {
        // Usually the newest: append; an older n goes in its place.
        let at = entries.length
        while (at > 0 && entries[at - 1].n > e.n) at--
        entries.splice(at, 0, e)
      }
    }
  }
  return { ...view, header: d.header ?? view.header, entries }
}

/**
 * The snapshot plus the deltas that arrived while it loaded (the view watches first, so nothing
 * falls between the two); only deltas newer than the snapshot apply, so none undoes it.
 */
export function applyBuffered(view: ChatView, deltas: readonly ChatDelta[]): ChatView {
  let v: ChatView = view
  for (const d of deltas)
    if (d.seq === undefined || view.seq === undefined || d.seq > view.seq) v = applyDelta(v, d) ?? v
  return v
}

/** The list follows a header push only when the row would change (phase or title). */
export function rowChanged(list: readonly ChatSummary[], h: ChatHeader): boolean {
  const row = list.find((r) => r.id === h.id)
  return !row || row.title !== h.title || row.phase !== h.phase
}

export type ChatItem =
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'tools'; key: number; entries: Extract<ChatEntry, { k: 'tool' }>[] }

/**
 * Consecutive tool rows: a long run folds into one group (it opens to show each step). A
 * run_subagents row (with jobs) stays on its own: it is a group of its own.
 */
export function groupEntries(entries: readonly ChatEntry[], min = GROUP_MIN): ChatItem[] {
  const out: ChatItem[] = []
  let run: Extract<ChatEntry, { k: 'tool' }>[] = []
  const flush = (): void => {
    if (run.length >= min) out.push({ type: 'tools', key: run[0].n, entries: run })
    else run.forEach((entry) => out.push({ type: 'entry', entry }))
    run = []
  }
  for (const e of entries) {
    if (e.k === 'tool' && !e.jobs) run.push(e)
    else {
      flush()
      out.push({ type: 'entry', entry: e })
    }
  }
  flush()
  return out
}

export const PHASE_TEXT: Record<ChatPhase, string> = {
  queued: 'Waiting to start',
  running: 'Running',
  paused: 'Paused',
  asking: 'Needs your answer',
  confirm: 'Needs your OK',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Stopped when Lumen closed'
}

export const TOOL_STATUS_TEXT: Record<ToolStatus, string> = {
  running: 'running',
  ok: 'ok',
  error: 'failed',
  denied: 'not allowed'
}

export function isLive(phase: ChatPhase): boolean {
  return (
    phase === 'running' ||
    phase === 'asking' ||
    phase === 'confirm' ||
    phase === 'paused' ||
    phase === 'queued'
  )
}

/** "2 min 05 s", "45 s", "1 h 3 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/** "12 steps · 4 model calls · $0.03 · 2 min 05 s". */
export function headerFacts(h: ChatHeader, now: number): string {
  const parts = [`${h.steps} ${h.steps === 1 ? 'step' : 'steps'}`]
  if (h.modelCalls)
    parts.push(
      h.kind === 'claude'
        ? `${h.modelCalls} ${h.modelCalls === 1 ? 'turn' : 'turns'}`
        : `${h.modelCalls} model ${h.modelCalls === 1 ? 'call' : 'calls'}`
    )
  if (h.costUsd >= 0.005) parts.push(`$${h.costUsd.toFixed(2)}`)
  parts.push(duration((h.endedAt ?? now) - h.startedAt))
  return parts.join(' · ')
}

export const JOB_STATUS_TEXT: Record<SubJob['status'], string> = {
  queued: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

/** "3 helpers · 2 working · 1 done · $0.02". */
export function jobsLine(jobs: readonly SubJob[]): string {
  const n = jobs.length
  const parts = [`${n} ${n === 1 ? 'helper' : 'helpers'}`]
  for (const s of ['running', 'queued', 'done', 'failed', 'stopped'] as const) {
    const k = jobs.filter((j) => j.status === s).length
    if (k) parts.push(`${k} ${JOB_STATUS_TEXT[s]}`)
  }
  const cost = jobs.reduce((a, j) => a + j.costUsd, 0)
  if (cost >= 0.005) parts.push(`$${cost.toFixed(2)}`)
  return parts.join(' · ')
}

/** "researcher · working · Read example.com". */
export function jobLine(j: SubJob): string {
  const now = j.status === 'running' && j.step ? ` · ${j.step}` : ''
  return `${j.role} · ${JOB_STATUS_TEXT[j.status]}${now}`
}

/** "12 steps · 1 failed · 4 earlier not kept", or null when the job kept no steps. */
export function jobStepsLine(j: SubJob): string | null {
  const steps = j.steps ?? []
  const dropped = j.stepsDropped ?? 0
  if (!steps.length && !dropped) return null
  const total = steps.length + dropped
  const parts = [`${total} ${total === 1 ? 'step' : 'steps'}`]
  const failed = steps.filter((s) => s.status === 'error' || s.status === 'denied').length
  if (failed) parts.push(`${failed} failed`)
  if (dropped) parts.push(`${dropped} earlier not kept`)
  return parts.join(' · ')
}

/** A job's step as a tool row (the same row the task's own steps use). */
export function stepEntry(st: JobStep): Extract<ChatEntry, { k: 'tool' }> {
  return {
    k: 'tool',
    n: st.n,
    at: 0,
    name: '',
    label: st.label,
    status: st.status,
    ...(st.args ? { args: st.args } : {}),
    ...(st.result ? { result: st.result } : {})
  }
}

/** "Clicked “Reply” · ok". */
export function toolLine(e: Extract<ChatEntry, { k: 'tool' }>): string {
  return `${e.label} · ${TOOL_STATUS_TEXT[e.status]}`
}

/** What the screen reader hears for a new entry (tool rows stay quiet unless they fail). */
export function announcement(e: ChatEntry, title: string): string | null {
  switch (e.k) {
    case 'assistant':
      return `${title}: ${e.text.slice(0, 300)}`
    case 'question':
      return e.answer === undefined ? `${title} asks: ${e.text}` : null
    case 'result':
      return `${title} ${e.ok ? 'finished' : 'stopped'}: ${e.text.slice(0, 300)}`
    case 'error':
      return `${title}: error. ${e.text}`
    case 'tool':
      return e.status === 'error' || e.status === 'denied' ? `${toolLine(e)}` : null
    case 'status':
      return e.text
    default:
      return null
  }
}

/** The composer's label: an answer while a question waits, else a message. */
export function composerLabel(h: ChatHeader): string {
  if (h.question) return 'Your answer'
  if (h.kind === 'claude') return 'Message Claude'
  return 'Message the task'
}

export function composerHint(h: ChatHeader): string {
  if (h.question) return 'Goes to the waiting question.'
  if (!h.canSteer)
    return isLive(h.phase) ? 'This task takes no messages right now.' : 'This task has ended.'
  if (h.kind === 'claude') return 'Sent to Claude as your next turn.'
  return 'The task reads it before its next step.'
}

/** Side list rows: a short phase word per kind. */
export function summaryStatus(s: ChatSummary): string {
  const kind =
    s.kind === 'claude' ? 'Claude Code' : s.kind === 'foreground' ? 'On screen' : 'Background'
  return `${kind} · ${PHASE_TEXT[s.phase]}`
}
