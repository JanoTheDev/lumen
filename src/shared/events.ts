// Internal bus events (CONTRACTS C6). Features publish; window modules subscribe.
import type { Action, BackgroundTask, ModelResponse, Point, Rect } from './types'
import type { ClaudeBarView } from './claude-code'

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
  answer?: {
    turnId: string
    markdown: string
    streaming: boolean
    pinned: boolean
    /** Answer cards under the text (05 Phase R), read with `cards:get`. */
    cardsId?: string
  }
  confirm?: {
    actionId: string
    summary: string
    risk: 'low' | 'medium' | 'high'
    countdownMs?: number
    /** A grantable medium confirm: the scope the "Always" button allows ("Outlook"). */
    alwaysLabel?: string
  }
  error?: { message: string; hint?: string; announced?: boolean }
  /**
   * A short feedback line (voice command result, focus, lesson line) for users who get no
   * speech. `audible`: the screen reader or TTS already said it; `echo`: same as statusText.
   */
  live?: {
    id: number
    text: string
    kind: string
    assertive: boolean
    audible: boolean
    echo?: boolean
  }
  /** The caption is open for a correction ("correct that" / "spell that" / Edit). */
  captionEdit?: { mode: 'edit' | 'spell'; draft: string }
  /** A short notice with an optional action button (muted output → Unmute, an edit → Undo). */
  notice?: { text: string; action?: 'unmute' | 'undo' }
  model?: string
  /** The running agent-mode task: plan, step list and counters (08 T13). */
  agentTask?: AgentTask
  /** The focused Claude Code session (08 T39). */
  claude?: ClaudeBarView
}

export type AgentStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type AgentPhase =
  | 'planning'
  | 'countdown'
  | 'running'
  | 'confirm'
  | 'asking'
  | 'paused'
  | 'done'
  | 'failed'
  | 'aborted'

/**
 * One agent-mode task (CONTRACTS C6, agent-loop.md). Steps come from the announced plan;
 * `detail` lists the tool calls made for a step (collapsible in the bar). A failed step can be
 * retried with `assistant:command {type: "retry", step}`.
 */
export interface AgentTask {
  id: string
  prompt: string
  /** "draft an email to Sam" (spoken as "I'll ..."). */
  summary: string
  plan: string[]
  steps: { i: number; label: string; status: AgentStepStatus; detail?: string[] }[]
  phase: AgentPhase
  /** ask_user: the question and its answer buttons. */
  question?: { text: string; choices?: string[] }
  /** Countdown before the first action (cancel window). */
  countdownMs?: number
  /** What the user still has to do (finish needsUserAction), pinned after the task. */
  needsUserAction?: string
  counters: { actions: number; modelCalls: number; costUsd: number; startedAt: number }
}

export interface ScreenScene {
  monitorId: number
  buddy?: { to: Point; label?: string; mode: 'idle' | 'fly' | 'point' | 'wait' }
  /** A buddy working on screen (08 T53): the on-screen buddy takes its colour and name tag. */
  worker?: { name: string; color: string }
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
  /** Lesson step target (07 T21): dwell clicks near it snap onto it. Not drawn. */
  dwellSnap?: Rect
  /** Switch scanning (06): ring around the highlighted item and/or a menu of the level. */
  scan?: ScanScene
  /** Focus mode (11 T14): everything but `keep` is dimmed. Click-through like the rest. */
  focus?: FocusScene
}

export interface FocusScene {
  /** soft = 40% dim; strong = 85% dim plus labels on the hidden areas. */
  level: 'soft' | 'strong'
  /** Rects left clear (global logical px, then display DIP). */
  keep: Rect[]
  /** Strong only: what a dimmed area holds ("Outliner"). */
  labels?: { rect: Rect; text: string }[]
}

export interface ScanScene {
  /** Ring around the highlighted item. */
  ring?: { rect: Rect; label: string; n?: number }
  /** Menu panel listing the level's items; `at` is where it goes (global, then display DIP). */
  menu?: { title: string; items: string[]; index: number; at: Point }
}

/**
 * Lesson navigation (07 T16): voice, keyboard and switch all map onto these. "perform" is
 * "click it" / "press it": Lumen performs the step's own click or keys (07 T21).
 */
export const LESSON_COMMANDS = [
  'next',
  'back',
  'repeat',
  'skip',
  'stop',
  'pause',
  'resume',
  'help',
  'do-it',
  'why',
  'done',
  'slower',
  'faster',
  'yes',
  'no',
  'perform'
] as const

export type LessonCommand = (typeof LESSON_COMMANDS)[number]

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
  /** `ended`: the renderer already finished the recording itself (silence, no speech, error). */
  | { type: 'voice.stopped'; ended?: boolean }
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
  /** One spoken message finished playing in the voice renderer (or was stopped / failed). */
  | {
      type: 'speech.finished'
      turnId: string
      seq: number
      reason: 'ended' | 'stopped' | 'failed'
    }
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
  | {
      type: 'a11y.announce'
      text: string
      priority: 'polite' | 'assertive'
      /** answer, status, step, error, confirm, focus, command, scan, phase (a11y/announce). */
      kind?: string
      /** Who voiced it: the screen reader, Lumen's TTS, or nobody (shown only). */
      via?: 'sr' | 'tts' | 'none'
    }
  /** Agent-mode task state; null once the task is over and its card is gone. */
  | { type: 'agent.task'; task: AgentTask | null }
  /** A background task changed (CONTRACTS C11). */
  | { type: 'task.changed'; task: BackgroundTask }
  /** Buddies were added, changed or removed (08 T50); `ids` = which ones. */
  | { type: 'buddies.changed'; ids: string[] }
  /** A buddy started (active) or stopped working on screen (08 T52; T53 tags the buddy). */
  | { type: 'buddy.working'; buddyId: string; active: boolean }
  /**
   * The focused Claude Code session on the bar (08 T39): `show` puts it up, otherwise only a
   * view already shown is updated; null takes session `id` (or any) down.
   */
  | { type: 'claude.bar'; view: ClaudeBarView | null; show?: boolean; id?: string }
  /** A key was pasted or removed in the app (never carries the key). */
  | { type: 'keys.changed'; provider: 'anthropic' | 'openai' | 'gemini' | 'compatible' }
  /** A card set changed (an image loaded): views re-read it with `cards:get`. */
  | { type: 'cards.changed'; id: string }
  /** A card's "do" button ("Book it"); the booking task (05 T41) handles it. */
  | { type: 'cards.do'; id: string; cardId: string; label: string }

export type AppEventType = AppEvent['type']
