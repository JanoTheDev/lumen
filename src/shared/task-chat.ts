// Task chat view (08 T41): the transcript of a background task, a foreground agent task or a
// Claude Code session, as the panel's #/tasks/<id> view shows it. Types for main and the
// renderer, plus the validators of its IPC payloads (channels.ts imports the types only).
import { z } from 'zod'

/** bg_… background task, t_… foreground agent task, cc_… Claude Code session. */
export type ChatKind = 'background' | 'foreground' | 'claude'

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

interface EntryBase {
  /** Increasing per transcript; an entry sent again with the same n replaces the old one. */
  n: number
  at: number
}

export type ChatEntry = EntryBase &
  (
    | { k: 'user'; text: string; steer?: boolean }
    | { k: 'assistant'; text: string }
    | {
        k: 'tool'
        name: string
        /** "Clicked “Reply”", "Read example.com/page". */
        label: string
        /** Short, redacted argument summary. */
        args?: string
        status: ToolStatus
        /** Short, redacted result or observation. */
        result?: string
      }
    | { k: 'question'; text: string; choices?: string[]; answer?: string }
    | { k: 'status'; text: string }
    | { k: 'error'; text: string }
    | { k: 'result'; text: string; report?: string; ok: boolean }
  )

export type ChatEntryKind = ChatEntry['k']

export type ChatPhase =
  | 'queued'
  | 'running'
  | 'paused'
  | 'asking'
  | 'confirm'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ChatHeader {
  id: string
  kind: ChatKind
  title: string
  phase: ChatPhase
  /** Tool calls so far. */
  steps: number
  modelCalls: number
  costUsd: number
  startedAt: number
  endedAt?: number
  /** A question waiting for the user (answer from the composer or a choice). */
  question?: { text: string; choices: string[] }
  /** A confirm waiting on the assistant bar (foreground): approve / deny from the view. */
  confirm?: string
  canStop: boolean
  canPause: boolean
  canResume: boolean
  canRunAgain: boolean
  /** The composer sends a message the task reads before its next step. */
  canSteer: boolean
  /** Claude Code session: the project's name. */
  project?: string
}

export interface ChatView {
  header: ChatHeader
  entries: ChatEntry[]
  /** Older entries dropped by the size cap. */
  dropped: number
}

/** Pushed to the open view only (tasks:watch). */
export interface ChatDelta {
  id: string
  header?: ChatHeader
  /** New or replaced entries (upsert by n). */
  entries?: ChatEntry[]
}

/** One row of the view's task list. */
export interface ChatSummary {
  id: string
  kind: ChatKind
  title: string
  phase: ChatPhase
  at: number
  unseen?: boolean
}

export type ChatControlOp = 'stop' | 'pause' | 'resume' | 'run-again' | 'approve' | 'deny'

export interface ChatSteerResult {
  ok: boolean
  /** answer: it went to the waiting question; steer: the task reads it before its next step. */
  how?: 'answer' | 'steer' | 'sent'
  error?: string
  /** run-again: the new task's chat id. */
  id?: string
}

export const chatIdSchema = z.string().regex(/^(bg|t|cc)_[a-z0-9]{4,40}$/)
export const chatWatchSchema = z.tuple([chatIdSchema, z.boolean()])
export const chatSteerSchema = z
  .object({ id: chatIdSchema, text: z.string().trim().min(1).max(2000) })
  .strict()
export const chatControlSchema = z
  .object({
    id: chatIdSchema,
    op: z.enum(['stop', 'pause', 'resume', 'run-again', 'approve', 'deny'])
  })
  .strict()

export function chatKind(id: string): ChatKind {
  return id.startsWith('cc_') ? 'claude' : id.startsWith('t_') ? 'foreground' : 'background'
}
