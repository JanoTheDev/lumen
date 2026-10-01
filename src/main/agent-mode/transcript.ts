// Task transcripts (08 T43): what a background task, a foreground agent task or a Claude Code
// session said and did, for the task chat view. Pure: entries in memory with size caps and
// redaction; persistence and live pushes are the hub's (transcript-hub.ts).
//
// Privacy: every text goes through the secret redactor before it is kept; typed text is never
// kept (only its length, like the audit log); results and observations are cut to a few
// hundred characters; screenshots are never kept.
import type { ChatEntry, ChatKind, ChatPhase, ToolStatus } from '@shared/task-chat'
import type { ToolCall, ToolContent } from '../ai/providers/types'
import { redactForLog } from '../actions/redact'

export const MAX_ENTRIES = 400
/** Rough cap on the kept text (characters) per transcript. */
export const MAX_CHARS = 200_000
export const TEXT_MAX = 4000
export const REPORT_MAX = 12_000
export const ARGS_MAX = 200
export const RESULT_MAX = 600
export const QUESTION_MAX = 600

/** What the runner reports while it runs (RunnerDeps.observe). */
export type RunEvent =
  | { type: 'model'; text: string }
  | { type: 'call'; call: ToolCall }
  | { type: 'result'; call: ToolCall; outcome: { content: ToolContent[]; isError?: boolean } }

/** The header facts kept with a transcript (foreground tasks and Claude sessions have no task file). */
export interface ChatMeta {
  kind: ChatKind
  title: string
  phase: ChatPhase
  startedAt: number
  endedAt?: number
  modelCalls: number
  costUsd: number
  project?: string
}

export interface TranscriptData {
  id: string
  entries: ChatEntry[]
  dropped: number
  meta?: ChatMeta
}

type Obj = Record<string, unknown>
type NewEntry = ChatEntry extends infer E
  ? E extends ChatEntry
    ? Omit<E, 'n' | 'at'>
    : never
  : never

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function clip(text: string, max: number): string {
  const t = text.replace(/[ \t]+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max)
}

function host(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return oneLine(`${u.host}${path}`, 80)
  } catch {
    return oneLine(url, 80)
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const quoted = (s: string): string => `“${oneLine(s, 60)}”`

/** "Clicked “Reply”", "Pressed ctrl+s", "Read example.com/page": one line per tool call. */
export function toolLabel(name: string, input: Obj): string {
  switch (name) {
    case 'observe':
      return input.what === 'window' ? 'Checked the window' : 'Looked at the screen'
    case 'act': {
      const t = input.target as { kind?: string; ref?: string } | undefined
      const on = t?.ref && t.kind !== 'point' ? ` ${quoted(t.ref)}` : ''
      const typed = str(input.value)
      switch (input.op) {
        case 'click':
        case 'invoke':
          return `Clicked${on}`
        case 'double_click':
          return `Double-clicked${on}`
        case 'right_click':
          return `Right-clicked${on}`
        case 'type':
        case 'set_value':
          return `Typed ${typed?.length ?? 0} characters${on ? ` into${on}` : ''}`
        case 'select':
          return `Picked ${typed ? quoted(typed) : 'an option'}${on ? ` in${on}` : ''}`
        case 'scroll':
          return 'Scrolled'
        default:
          return `${String(input.op ?? 'Used').replace(/_/g, ' ')}${on}`.replace(/^./, (c) =>
            c.toUpperCase()
          )
      }
    }
    case 'keys':
      return `Pressed ${oneLine(String(input.combo ?? ''), 40)}`
    case 'navigate':
      return `Opened ${host(String(input.url ?? ''))}`
    case 'fetch_url':
      return `Read ${host(String(input.url ?? ''))}`
    case 'launch_app':
      return `Started ${oneLine(String(input.app ?? 'an app'), 60)}`
    case 'wait_for': {
      const c = input.condition as { value?: string } | undefined
      return `Waited for ${quoted(c?.value ?? '')}`
    }
    case 'read_file':
      return `Read ${str(input.path) ? baseName(String(input.path)) : 'a file'}`
    case 'memory_search':
      return `Searched memory${str(input.query) ? ` for ${quoted(String(input.query))}` : ''}`
    case 'memory_write':
      return 'Saved a note to memory'
    case 'notify':
      return 'Sent you a notice'
    case 'request_foreground':
      return 'Asked to use the mouse'
    case 'spawn_task':
      return `Started a helper: ${oneLine(String(input.prompt ?? ''), 60)}`
    case 'use_skill':
      return `Used the skill ${quoted(String(input.name ?? ''))}`
    case 'read_skill_file':
      return 'Read a skill file'
    case 'focus_mode':
      return input.on ? 'Turned focus mode on' : 'Turned focus mode off'
    case 'ask_user':
      return 'Asked you'
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
      if (m) return `Used ${m[2].replace(/_/g, ' ')} (${m[1]})`
      return `Used ${name.replace(/_/g, ' ')}`
    }
  }
}

/** Short argument summary; typed text only as its length. */
export function argsSummary(name: string, input: Obj): string | undefined {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (k === 'step' || v === undefined || v === null) continue
    if (name === 'act' && k === 'value' && (input.op === 'type' || input.op === 'set_value')) {
      parts.push(`value: ${String(v).length} chars`)
      continue
    }
    const s = typeof v === 'string' ? oneLine(v, 80) : oneLine(JSON.stringify(v) ?? '', 80)
    parts.push(`${k}: ${s}`)
  }
  const out = oneLine(parts.join(', '), ARGS_MAX)
  return out || undefined
}

/** Text of a tool result: observed fences dropped, images as a word, cut short. */
export function resultSummary(content: readonly ToolContent[], max = RESULT_MAX): string {
  const parts = content.map((c) =>
    c.type === 'text' ? c.text : c.type === 'image' ? '[screenshot]' : '[document]'
  )
  return oneLine(
    parts
      .join(' ')
      .replace(/<\/?observed[^>]*>/g, ' ')
      .replace(/<\/?untrusted[^>]*>/g, ' '),
    max
  )
}

function statusOf(isError: boolean | undefined, text: string): ToolStatus {
  if (!isError) return 'ok'
  return /^E_DENIED\b/.test(text) || /\bdenied\b/i.test(text.slice(0, 40)) ? 'denied' : 'error'
}

function size(e: ChatEntry): number {
  let n = 40
  for (const v of Object.values(e)) if (typeof v === 'string') n += v.length
  return n
}

export interface RecorderOptions {
  now(): number
  /** A new or replaced entry (the hub pushes it to an open view and saves later). */
  onEntry?(e: ChatEntry): void
  redact?(text: string): string
}

export class TranscriptRecorder {
  private list: ChatEntry[]
  private next: number
  private chars: number
  private calls = new Map<string, number>()
  dropped: number
  meta?: ChatMeta

  constructor(
    readonly id: string,
    private readonly opts: RecorderOptions,
    data?: TranscriptData
  ) {
    this.list = data?.entries ? [...data.entries] : []
    this.dropped = data?.dropped ?? 0
    this.meta = data?.meta
    this.next = this.list.reduce((m, e) => Math.max(m, e.n), 0) + 1
    this.chars = this.list.reduce((s, e) => s + size(e), 0)
  }

  get entries(): readonly ChatEntry[] {
    return this.list
  }

  /** Tool calls so far (the header's step count). */
  get steps(): number {
    return this.list.filter((e) => e.k === 'tool').length
  }

  data(): TranscriptData {
    return {
      id: this.id,
      entries: [...this.list],
      dropped: this.dropped,
      ...(this.meta ? { meta: this.meta } : {})
    }
  }

  private clean(text: string, max: number): string {
    return clip((this.opts.redact ?? redactForLog)(text), max)
  }

  private add(e: NewEntry): ChatEntry {
    const entry = { ...e, n: this.next++, at: this.opts.now() } as ChatEntry
    this.list.push(entry)
    this.chars += size(entry)
    this.trim()
    this.opts.onEntry?.(entry)
    return entry
  }

  private replace(n: number, patch: Partial<ChatEntry>): void {
    const i = this.list.findIndex((e) => e.n === n)
    if (i < 0) return
    const old = this.list[i]
    const entry = { ...old, ...patch } as ChatEntry
    this.list[i] = entry
    this.chars += size(entry) - size(old)
    this.opts.onEntry?.(entry)
  }

  /** Oldest entries go first; the task's own prompt (the first entry) stays. */
  private trim(): void {
    while (this.list.length > 2 && (this.list.length > MAX_ENTRIES || this.chars > MAX_CHARS)) {
      const at = this.list[0].k === 'user' ? 1 : 0
      const [gone] = this.list.splice(at, 1)
      this.chars -= size(gone)
      this.dropped++
    }
  }

  private last(): ChatEntry | undefined {
    return this.list[this.list.length - 1]
  }

  user(text: string, steer = false): void {
    const t = this.clean(text, TEXT_MAX)
    if (t) this.add({ k: 'user', text: t, ...(steer ? { steer: true } : {}) })
  }

  assistant(text: string): void {
    const t = this.clean(text, TEXT_MAX)
    if (!t) return
    const last = this.last()
    if (last?.k === 'assistant' && last.text === t) return
    this.add({ k: 'assistant', text: t })
  }

  status(text: string): void {
    const t = this.clean(text, QUESTION_MAX)
    const last = this.last()
    if (!t || (last?.k === 'status' && last.text === t)) return
    this.add({ k: 'status', text: t })
  }

  error(text: string): void {
    const t = this.clean(text, QUESTION_MAX)
    if (t) this.add({ k: 'error', text: t })
  }

  result(text: string, ok: boolean, report?: string): void {
    const t = this.clean(text, TEXT_MAX)
    const r = report ? this.clean(report, REPORT_MAX) : ''
    const last = this.last()
    if (last?.k === 'result' && last.text === t) return
    this.add({
      k: 'result',
      text: t || (ok ? 'Done.' : 'It stopped.'),
      ok,
      ...(r ? { report: r } : {})
    })
  }

  /** A question for the user; the same open question asked again is kept once. */
  question(text: string, choices?: readonly string[]): number {
    const t = this.clean(text, QUESTION_MAX)
    const open = this.openQuestion()
    if (open && open.text === t) return open.n
    const c = (choices ?? [])
      .map((x) => this.clean(x, 60))
      .filter(Boolean)
      .slice(0, 4)
    return this.add({ k: 'question', text: t, ...(c.length ? { choices: c } : {}) }).n
  }

  /** The newest question without an answer. */
  openQuestion(): Extract<ChatEntry, { k: 'question' }> | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i]
      if (e.k === 'question') return e.answer === undefined ? e : undefined
    }
    return undefined
  }

  /** The user's answer: on the open question, or a plain user line when none is open. */
  answer(text: string): void {
    const q = this.openQuestion()
    const t = this.clean(text, QUESTION_MAX)
    if (q) this.replace(q.n, { answer: t })
    else this.user(text)
  }

  /** `label`: a ready label (Claude's tools) in place of toolLabel. */
  toolStart(call: ToolCall, label?: string): void {
    if (call.name === 'finish') return
    const input = call.input ?? {}
    if (call.name === 'ask_user') {
      const choices = Array.isArray(input.choices) ? input.choices.map(String) : undefined
      this.calls.set(call.id, this.question(String(input.question ?? ''), choices))
      return
    }
    const args = argsSummary(call.name, input)
    const e = this.add({
      k: 'tool',
      name: call.name,
      label: this.clean(label ?? toolLabel(call.name, input), 160),
      ...(args ? { args: this.clean(args, ARGS_MAX) } : {}),
      status: 'running'
    })
    this.calls.set(call.id, e.n)
  }

  toolEnd(call: ToolCall, outcome: { content: ToolContent[]; isError?: boolean }): void {
    const n = this.calls.get(call.id)
    if (n === undefined) return
    this.calls.delete(call.id)
    const text = resultSummary(outcome.content)
    const entry = this.list.find((e) => e.n === n)
    if (entry?.k === 'question') {
      if (entry.answer === undefined && text && !outcome.isError)
        this.replace(n, { answer: this.clean(text, QUESTION_MAX) })
      return
    }
    this.replace(n, {
      status: statusOf(outcome.isError, text),
      ...(text ? { result: this.clean(text, RESULT_MAX) } : {})
    })
  }

  /** Marks calls still running as stopped (the run ended under them). */
  closeOpen(): void {
    for (const n of this.calls.values()) {
      const e = this.list.find((x) => x.n === n)
      if (e?.k === 'tool' && e.status === 'running')
        this.replace(n, { status: 'error', result: 'Stopped.' })
    }
    this.calls.clear()
  }

  run(ev: RunEvent): void {
    if (ev.type === 'model') this.assistant(ev.text)
    else if (ev.type === 'call') this.toolStart(ev.call)
    else this.toolEnd(ev.call, ev.outcome)
  }
}

/** The text a steer message reaches the model as (it is the user's own words). */
export function steerTurn(notes: readonly string[]): string {
  const lines = notes.map((n) => `- ${n.replace(/\s+/g, ' ').trim()}`).join('\n')
  return `The user added this while you work (their own words; take it into account from now on):\n${lines}`
}
