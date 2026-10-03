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
import { onConfirmOwnerChange, ownedConfirmId } from './confirm'
import {
  agentTaskPaused,
  canPauseAgentTask,
  pauseAgentTask,
  resumePausedAgentTask,
  runningAgentTaskId,
  stopAgentTask
} from './session'
import { PERMISSION_CHOICES } from './transcript-claude'
import {
  backgroundHeader,
  chatIdForTask,
  chatSummaries,
  claudeHeader,
  claudeToken,
  foregroundHeader,
  questionToken
} from './transcript-header'
import { findSessionFile, loadClaudeHistory, readTail } from './transcript-history'
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
        steps: (isOpen(t) ? hub.rec(id) : hub.peek(id)).steps,
        steerable: m.steerable(id)
      })
    }
    case 'foreground': {
      const meta = hub.meta(id)
      if (!meta) return null
      const running = runningAgentTaskId() === id
      const r = running ? hub.rec(id) : hub.peek(id)
      const q = r.openQuestion()
      // Only a card this task asked for (tagged where it was made), never another one on the bar.
      const confirmId = running ? ownedConfirmId(id) : null
      const card = confirmId ? assistant.state().confirm : undefined
      return foregroundHeader(id, meta, {
        running,
        steps: r.steps,
        ...(q && askPending() ? { question: { text: q.text, choices: q.choices } } : {}),
        ...(confirmId && card ? { confirm: { id: confirmId, summary: card.summary } } : {}),
        paused: running && agentTaskPaused(id),
        pausable: running && (agentTaskPaused(id) || canPauseAgentTask(id))
      })
    }
    case 'claude': {
      const v = getCopilot()?.get(id) ?? null
      if (!v && !hub.has(id)) return null
      return claudeHeader(id, v, hub.meta(id), (v ? hub.rec(id) : hub.peek(id)).steps)
    }
  }
}

export function chatList(): ChatSummary[] {
  const m = backgroundManager()
  const tasks = m.list()
  const fg = runningAgentTaskId()
  const pausedIds = new Set(tasks.filter((t) => m.isPaused(t.id)).map((t) => t.id))
  if (fg && agentTaskPaused(fg)) pausedIds.add(fg)
  return chatSummaries(tasks, transcripts().metas(), { pausedIds, runningFg: fg })
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

const CHANGED: ChatSteerResult = {
  ok: false,
  error: 'That question changed. Look at the new one first.'
}

/** A token the view sent that no longer names what is waiting (undefined: none sent, by voice). */
const stale = (token: string | undefined, now: string): boolean =>
  token !== undefined && token !== now

/** "Allow" / "Always allow" / "Deny" from the chat → the waiting permission it was shown for. */
function answerPermission(
  sessionId: string,
  p: { permId?: string },
  answer: 'once' | 'always' | 'deny'
): ChatSteerResult {
  const task = claudeTask(sessionId)
  const label = answer === 'once' ? 'Allow' : answer === 'always' ? 'Always allow' : 'Deny'
  if (task && backgroundManager().answer(task, label)) return { ok: true, how: 'answer' }
  // Without its id the bridge would answer the oldest waiting permission, maybe another one.
  if (!p.permId) return { ok: false, error: 'Answer this one on the assistant bar.' }
  return getBridge()?.answer(answer, p.permId) ? { ok: true, how: 'answer' } : CHANGED
}

function permissionChoice(text: string): 'once' | 'always' | 'deny' | null {
  const i = PERMISSION_CHOICES.findIndex((c) => c.toLowerCase() === text.trim().toLowerCase())
  return i < 0 ? null : (['once', 'always', 'deny'] as const)[i]
}

/**
 * A message from the composer or a choice button: answers a waiting question, else steers the
 * task. `token`: the question the view showed; a newer one is not answered with it.
 */
export function steerChat(id: string, text: string, token?: string): ChatSteerResult {
  const hub = transcripts()
  const m = backgroundManager()
  switch (chatKind(id)) {
    case 'background': {
      const t = m.get(id)
      if (!t || t.claude) return { ok: false, error: 'No such task.' }
      if (t.question && (t.phase === 'asking' || t.phase === 'needs-foreground')) {
        if (stale(token, questionToken(t.question.text))) return CHANGED
        return m.answer(id, text) ? { ok: true, how: 'answer' } : { ok: false }
      }
      if (token !== undefined) return CHANGED
      return m.steer(id, text)
        ? { ok: true, how: 'steer' }
        : { ok: false, error: isOpen(t) ? 'Too many messages are waiting.' : 'The task ended.' }
    }
    case 'foreground': {
      if (runningAgentTaskId() !== id) return { ok: false, error: 'The task is not running.' }
      if (askPending()) {
        const q = hub.rec(id).openQuestion()
        if (stale(token, q ? questionToken(q.text) : '')) return CHANGED
        hub.rec(id).answer(text)
        return answerQuestion(text) ? { ok: true, how: 'answer' } : { ok: false }
      }
      if (token !== undefined) return CHANGED
      return hub.steer(id, text)
        ? { ok: true, how: 'steer' }
        : { ok: false, error: 'Too many messages are waiting.' }
    }
    case 'claude': {
      const c = getCopilot()
      const v = c?.get(id)
      if (!c || !v) return { ok: false, error: 'The Claude session is closed.' }
      const p = v.pending
      if (p ? stale(token, claudeToken(p)) : token !== undefined) return CHANGED
      if (p?.kind === 'permission') {
        const answer = permissionChoice(text)
        if (!answer) return { ok: false, error: 'Allow or deny the waiting permission first.' }
        return answerPermission(id, p, answer)
      }
      const task = p ? claudeTask(id) : null
      if (task && m.answer(task, text)) return { ok: true, how: 'answer' }
      if (p?.kind === 'question') c.answerQuestion(id, text)
      else c.send(id, text)
      return { ok: true, how: p ? 'answer' : 'sent' }
    }
  }
}

/** `token`: approve / deny name the confirm or question the view showed. */
export function controlChat(id: string, op: ChatControlOp, token?: string): ChatSteerResult {
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
        if (token !== questionToken(t.question.text)) return CHANGED
        return { ok: m.answer(id, pickChoice(t.question.choices, op === 'approve')) }
    }
  }
  if (kind === 'foreground') {
    const running = runningAgentTaskId() === id
    switch (op) {
      case 'stop':
        return { ok: stopAgentTask(id) }
      case 'pause':
        return { ok: pauseAgentTask(id) }
      case 'resume':
        return { ok: resumePausedAgentTask(id) }
      case 'run-again': {
        const first = hub.rec(id).entries.find((e) => e.k === 'user')
        if (running || first?.k !== 'user') return { ok: false }
        assistant.send('assistant:run-query', first.text)
        return { ok: true }
      }
      case 'approve':
      case 'deny': {
        if (!running) return { ok: false }
        if (assistant.confirmPending()) {
          // Only the task's own card, and only the one the view showed.
          const own = ownedConfirmId(id)
          if (!own || token !== own) return CHANGED
          assistant.command({ type: op === 'approve' ? 'confirm' : 'deny' })
          return { ok: true }
        }
        if (askPending()) {
          const q = hub.rec(id).openQuestion()
          if (!q || token !== questionToken(q.text)) return CHANGED
          const a = pickChoice(q.choices, op === 'approve')
          hub.rec(id).answer(a)
          return { ok: answerQuestion(a) }
        }
        return { ok: false }
      }
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
      if (token !== claudeToken(p)) return CHANGED
      if (p.kind === 'permission')
        return answerPermission(id, p, op === 'approve' ? 'once' : 'deny')
      const answer = pickChoice(p.choices, op === 'approve')
      const task = claudeTask(id)
      if (task && m.answer(task, answer)) return { ok: true }
      return { ok: c.answerQuestion(id, answer) }
    }
    default:
      return { ok: false }
  }
}

// ---- live pushes to the panel window ----

const views = new Map<string, () => void>()
/** Panel windows whose close ends every watch (a reopened panel watches again itself). */
const closing = new WeakSet<object>()

/** The panel window shows chat `id`: push its changes there (only while it is open). */
export function watchChat(id: string, on: boolean): boolean {
  if (!on) {
    views.get(id)?.()
    views.delete(id)
    return true
  }
  const win = panel.get()
  if (!win) return false
  if (!closing.has(win)) {
    closing.add(win)
    win.once('closed', unwatchAll)
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
  const row = pickChat(intent.name, steerable, { steer: true })
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
  // A task's own confirm card went up or away: its chat header shows or drops it.
  onConfirmOwnerChange((owner) => hub.touch(owner))
  hub.setHistorySource((id, rec) => {
    const v = getCopilot()?.get(id)
    if (!v?.sessionId) return
    const file = findSessionFile(v.sessionId, v.project)
    if (file) loadClaudeHistory(rec, readTail(file))
  })
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
