// Task chat wiring (08 T43): the hub's store and header source, Claude session taps, the
// panel's live pushes, the view's controls (stop / pause / resume / run again / approve /
// deny), steer messages and the voice commands. IPC handlers are in ipc/tasks.ts.
import { app } from 'electron'
import type { ChatControlOp, ChatHeader, ChatSteerResult, ChatSummary } from '@shared/task-chat'
import { chatKind } from '@shared/task-chat'
import { bus } from '../bus'
import { getBridge, getCopilot, onSessionChange } from '../claude-code'
import { sessionTaps } from '../claude-code/session'
import { log } from '../logger'
import * as assistant from '../windows/assistant'
import * as home from '../windows/home'
import * as panel from '../windows/settings'
import { answerQuestion, askPending } from './ask'
import { backgroundManager } from './background'
import { isOpen } from './background/manager'
import { runningAgentTaskId, stopAgentTask } from './session'
import {
  backgroundHeader,
  chatIdForTask,
  chatSummaries,
  claudeHeader,
  foregroundHeader
} from './transcript-header'
import { transcripts } from './transcript-hub'
import { TranscriptStore } from './transcript-store'
import { matchTaskChatIntent, pickChat } from './transcript-voice'

/** The live header of a chat, or null when there is no such chat. */
export function chatHeader(id: string): ChatHeader | null {
  const hub = transcripts()
  const m = backgroundManager()
  switch (chatKind(id)) {
    case 'background': {
      const t = m.get(id)
      if (!t || t.claude) return null
      return backgroundHeader(t, {
        paused: m.isPaused(id),
        steps: hub.rec(id).steps,
        steerable: m.steerable(id)
      })
    }
    case 'foreground': {
      const meta = hub.meta(id)
      if (!meta) return null
      const running = runningAgentTaskId() === id
      const r = hub.rec(id)
      const q = r.openQuestion()
      const confirm = running && assistant.confirmPending() ? assistant.state().confirm : undefined
      return foregroundHeader(id, meta, {
        running,
        steps: r.steps,
        ...(q && askPending() ? { question: { text: q.text, choices: q.choices } } : {}),
        ...(confirm ? { confirm: confirm.summary } : {})
      })
    }
    case 'claude': {
      const v = getCopilot()?.get(id) ?? null
      if (!v && !hub.has(id)) return null
      return claudeHeader(id, v, hub.meta(id), hub.rec(id).steps)
    }
  }
}

export function chatList(): ChatSummary[] {
  const m = backgroundManager()
  const tasks = m.list()
  return chatSummaries(tasks, transcripts().metas(), {
    pausedIds: new Set(tasks.filter((t) => m.isPaused(t.id)).map((t) => t.id)),
    runningFg: runningAgentTaskId()
  })
}

/** The open background task of a Claude session (it relays questions and permissions). */
function claudeTask(sessionId: string): string | null {
  const t = backgroundManager()
    .list()
    .find((x) => x.claude?.id === sessionId && isOpen(x))
  return t?.id ?? null
}

const APPROVE_RE = /^(allow|yes|ok|keep going|do it|go)/i
const DENY_RE = /^(deny|no|stop|cancel)/i

function pickChoice(choices: readonly string[] | undefined, approve: boolean): string {
  const re = approve ? APPROVE_RE : DENY_RE
  return choices?.find((c) => re.test(c)) ?? (approve ? 'Allow' : 'Deny')
}

/** A message from the composer: answers a waiting question, else steers the task. */
export function steerChat(id: string, text: string): ChatSteerResult {
  const hub = transcripts()
  const m = backgroundManager()
  switch (chatKind(id)) {
    case 'background': {
      const t = m.get(id)
      if (!t || t.claude) return { ok: false, error: 'No such task.' }
      if (t.question && (t.phase === 'asking' || t.phase === 'needs-foreground'))
        return m.answer(id, text) ? { ok: true, how: 'answer' } : { ok: false }
      return m.steer(id, text)
        ? { ok: true, how: 'steer' }
        : { ok: false, error: isOpen(t) ? 'Too many messages are waiting.' : 'The task ended.' }
    }
    case 'foreground': {
      if (runningAgentTaskId() !== id) return { ok: false, error: 'The task is not running.' }
      if (askPending()) {
        hub.rec(id).answer(text)
        return answerQuestion(text) ? { ok: true, how: 'answer' } : { ok: false }
      }
      return hub.steer(id, text)
        ? { ok: true, how: 'steer' }
        : { ok: false, error: 'Too many messages are waiting.' }
    }
    case 'claude': {
      const c = getCopilot()
      const v = c?.get(id)
      if (!c || !v) return { ok: false, error: 'The Claude session is closed.' }
      if (v.pending?.kind === 'permission')
        return { ok: false, error: 'Allow or deny the waiting permission first.' }
      const task = v.pending ? claudeTask(id) : null
      if (task && m.answer(task, text)) return { ok: true, how: 'answer' }
      if (v.pending?.kind === 'question') c.answerQuestion(id, text)
      else c.send(id, text)
      return { ok: true, how: v.pending ? 'answer' : 'sent' }
    }
  }
}

export function controlChat(id: string, op: ChatControlOp): ChatSteerResult {
  const m = backgroundManager()
  const hub = transcripts()
  const kind = chatKind(id)
  if (kind === 'background') {
    const t = m.get(id)
    if (!t || t.claude) return { ok: false }
    switch (op) {
      case 'stop':
        return { ok: m.cancel(id) }
      case 'pause':
        return { ok: m.pause(id) }
      case 'resume':
        return { ok: m.resume(id) }
      case 'run-again': {
        const n = m.runAgain(id)
        return n ? { ok: true, id: n.id } : { ok: false }
      }
      case 'approve':
      case 'deny':
        if (!t.question) return { ok: false }
        return { ok: m.answer(id, pickChoice(t.question.choices, op === 'approve')) }
    }
  }
  if (kind === 'foreground') {
    const running = runningAgentTaskId() === id
    switch (op) {
      case 'stop':
        return { ok: stopAgentTask(id) }
      case 'run-again': {
        const first = hub.rec(id).entries.find((e) => e.k === 'user')
        if (running || first?.k !== 'user') return { ok: false }
        assistant.send('assistant:run-query', first.text)
        return { ok: true }
      }
      case 'approve':
      case 'deny':
        if (!running) return { ok: false }
        if (assistant.confirmPending()) {
          assistant.command({ type: op === 'approve' ? 'confirm' : 'deny' })
          return { ok: true }
        }
        if (askPending()) {
          const q = hub.rec(id).openQuestion()
          const a = pickChoice(q?.choices, op === 'approve')
          hub.rec(id).answer(a)
          return { ok: answerQuestion(a) }
        }
        return { ok: false }
      default:
        return { ok: false }
    }
  }
  const c = getCopilot()
  const v = c?.get(id)
  if (!c || !v) return { ok: false }
  switch (op) {
    case 'stop':
      void c.interrupt(id)
      return { ok: true }
    case 'approve':
    case 'deny': {
      const p = v.pending
      if (!p) return { ok: false }
      const task = claudeTask(id)
      const answer =
        p.kind === 'permission'
          ? op === 'approve'
            ? 'Allow'
            : 'Deny'
          : pickChoice(p.choices, op === 'approve')
      if (task && m.answer(task, answer)) return { ok: true }
      if (p.kind === 'permission') {
        void getBridge()?.answer(op === 'approve' ? 'once' : 'deny', p.permId)
        return { ok: true }
      }
      return { ok: c.answerQuestion(id, answer) }
    }
    default:
      return { ok: false }
  }
}

// ---- live pushes to the panel window ----

const views = new Map<string, () => void>()

/** The panel window shows chat `id`: push its changes there (only while it is open). */
export function watchChat(id: string, on: boolean): boolean {
  if (!on) {
    views.get(id)?.()
    views.delete(id)
    return true
  }
  if (views.has(id)) return true
  const off = transcripts().watch(id, (d) => {
    if (!panel.get()) return unwatchAll()
    panel.send('tasks:chat-delta', d)
  })
  views.set(id, off)
  return true
}

function unwatchAll(): void {
  for (const off of views.values()) off()
  views.clear()
}

/** Opens the chat view in the panel window (Home row, tray, voice). */
export function openChat(id: string): void {
  home.hide()
  panel.create(id ? `tasks/${id}` : 'tasks')
}

/** Home's Tasks row → its chat id. */
export function chatForTask(taskId: string): string | null {
  const t = backgroundManager().get(taskId)
  return t ? chatIdForTask(t) : null
}

// ---- voice ----

function reply(text: string): { mode: 'answer'; text: string; spoken: string } {
  return { mode: 'answer', text, spoken: text }
}

/** "show me what the email task is doing" / "tell the background task to also check Outlook". */
export function interceptTaskChat(prompt: string): unknown | undefined {
  const intent = matchTaskChatIntent(prompt)
  if (!intent) return undefined
  const rows = chatList()
  if (intent.kind === 'show') {
    const row = pickChat(intent.name, rows)
    if (!row)
      return rows.length
        ? reply('I don’t see a task like that.')
        : reply('There are no tasks right now.')
    openChat(row.id)
    return reply(`Opening “${row.title}”.`)
  }
  const steerable = rows.filter((r) => chatHeader(r.id)?.canSteer)
  const row = pickChat(intent.name, steerable)
  // Nothing running to tell: the words go on as a normal request.
  if (!row) return undefined
  const r = steerChat(row.id, intent.text)
  if (!r.ok) return reply(r.error ?? 'I couldn’t pass that on.')
  return reply(
    r.how === 'answer' ? `Answered “${row.title}”.` : `Told “${row.title}”: ${intent.text}`
  )
}

// ---- install ----

let installed = false

export function installTranscripts(dir: string): void {
  if (installed) return
  installed = true
  const hub = transcripts()
  const store = new TranscriptStore(dir)
  hub.setStore(store)
  hub.setHeaderSource(chatHeader)
  try {
    store.prune(
      new Set(
        backgroundManager()
          .list()
          .map((t) => t.id)
      )
    )
  } catch (e) {
    log('fail', `transcripts prune: ${(e as Error).message}`)
  }
  bus.on('task.changed', (e) => {
    hub.touch(e.task.id)
    if (e.task.claude) hub.touch(e.task.claude.id)
  })
  bus.on('agent.task', (e) => {
    if (e.task) hub.touch(e.task.id)
  })
  sessionTaps.on('user', (id: string, text: string) =>
    hub.claudeUser(getCopilot()?.get(id) ?? null, id, text)
  )
  sessionTaps.on('event', (id: string, ev: Record<string, unknown>) => hub.claudeEvent(id, ev))
  onSessionChange((v) => hub.claudeView(v))
  app?.on('before-quit', () => hub.flushAll())
}
