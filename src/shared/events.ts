// Internal bus events (CONTRACTS C6). Features publish; window modules subscribe.
import type { Action, ModelResponse, Point, Rect } from './types'

export type AssistantPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'acting'
  | 'waiting-user'
  | 'confirm'
  | 'error'

export interface AssistantState {
  phase: AssistantPhase
  caption?: string
  statusText?: string
  step?: { index: number; total: number; label: string }
  answer?: { turnId: string; markdown: string; streaming: boolean; pinned: boolean }
  confirm?: {
    actionId: string
    summary: string
    risk: 'low' | 'medium' | 'high'
    countdownMs?: number
  }
  error?: { message: string; hint?: string }
  /** A short notice with an optional action button (muted output → Unmute). */
  notice?: { text: string; action?: 'unmute' }
  model?: string
}

export interface ScreenScene {
  monitorId: number
  buddy?: { to: Point; label?: string; mode: 'idle' | 'fly' | 'point' | 'wait' }
  highlights: {
    id: string
    rect: Rect
    style: 'target' | 'ring' | 'dim-reveal' | 'success' | 'failure'
    label?: string
    n?: number
  }[]
  marks?: { n: number; rect: Rect }[]
  grid?: { rect: Rect; cols: number; rows: number; level: number }
  dwell?: { at: Point; progress: number; clickType: string }
  /** Dwell v2 (06): scroll arrows around a point and the start of a dwell drag. */
  dwellUi?: { scrollAt?: Point; dragFrom?: Point }
  annotations?: { kind: 'arrow' | 'circle' | 'scribble' | 'text'; points: Point[]; text?: string }[]
}

/** Lesson navigation (07 T16): voice, keyboard and switch all map onto these. */
export type LessonCommand =
  | 'next'
  | 'back'
  | 'repeat'
  | 'skip'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'help'
  | 'do-it'
  | 'why'
  | 'done'
  | 'slower'
  | 'faster'
  | 'yes'
  | 'no'

/** Summed cost of every model call made for one user turn. */
export interface TurnCostSummary {
  usd: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type AppEvent =
  | { type: 'voice.started'; handsFree: boolean }
  | { type: 'voice.stopped' }
  | { type: 'voice.cancelled' }
  /** Dictation hotkey pressed: record for typing, not for the assistant. */
  | { type: 'dictation.started' }
  /** The open dictation recording becomes hands-free (ends on silence or a tap). */
  | { type: 'dictation.hands-free' }
  | { type: 'query.started'; turnId: string; prompt: string }
  /** Streamed text of the answer's spoken part, as it arrives. */
  | { type: 'query.delta'; turnId: string; delta: string }
  /** One complete sentence of the spoken answer, ready for TTS (index from 0). */
  | { type: 'speech.say-chunk'; turnId: string; text: string; index: number }
  | {
      type: 'query.done'
      turnId: string
      response: ModelResponse
      /** Model that produced the answer, e.g. claude-sonnet-5-5. */
      model?: string
      cost?: TurnCostSummary
    }
  | { type: 'query.failed'; turnId: string; error: string; cancelled?: boolean }
  /** The turn was cancelled (Esc, "cancel", a new turn); nothing of it reaches the screen or TTS. */
  | { type: 'query.cancelled'; turnId: string }
  | { type: 'action.planned'; actionId: string; actions: Action[] }
  | { type: 'action.confirmed'; actionId: string }
  | { type: 'action.executed'; actionId: string }
  | { type: 'action.failed'; actionId: string; error: string }
  | { type: 'lesson.step-started'; lessonId: string; step: number }
  | { type: 'lesson.step-completed'; lessonId: string; step: number }
  /** The lesson finished (completed) or was stopped. */
  | { type: 'lesson.done'; lessonId: string; completed: boolean }
  /** What a lesson draws, in global logical px; null clears it (07 T15). */
  | { type: 'lesson.scene'; scene: Omit<ScreenScene, 'monitorId'> | null }
  /** The assistant bar while a lesson runs; null hands the bar back. */
  | { type: 'lesson.state'; state: AssistantState | null }
  /** Keyboard / switch / bar input for the running lesson (voice goes through the router). */
  | { type: 'lesson.command'; command: LessonCommand }
  /** Passive "Resume Blender: Add an object, step 3?" at startup. */
  | { type: 'lesson.resume-offer'; lessonId: string; text: string }
  | { type: 'a11y.announce'; text: string; priority: 'polite' | 'assertive' }

export type AppEventType = AppEvent['type']
