// Lesson engine state, events and effects (plans 07 lesson-engine.md). The reducer in
// engine.ts maps (state, event) to (state, effects); runner.ts executes the effects.
// Pure types: no Electron.
import type { AssistantState, LessonCommand } from '@shared/events'
import type { Lesson } from './lesson'
import type { CheckResult } from './ports'

/**
 * The spec's transient states (step.present, step.hint, step.passed, failed-check) are
 * transitions here: they emit their effects and land in a resting phase. `step.passed`
 * rests for the success tick before the next step.
 */
export type Phase =
  | 'idle'
  | 'intro'
  | 'step.waiting'
  | 'step.checking'
  | 'step.passed'
  | 'ask-worked'
  | 'offer-do-it'
  | 'doing-it'
  | 'paused'
  | 'done'
  | 'aborted'

export type { LessonCommand }

export type LessonSource = 'pack' | 'user' | 'generated'

export interface StepStats {
  /** Failed checks after "done". */
  attempts: number
  /** Hint levels with hint text reached (0-3). */
  hints: number
  skipped: boolean
  doItForMe: boolean
}

export interface LessonState {
  phase: Phase
  lesson: Lesson | null
  skillId: string | null
  source: LessonSource
  index: number
  /** Hint ladder level of the current step (hints.ts). */
  level: number
  /** Hint timing multiplier: 1, 1.5 or 2. */
  pace: number
  stats: Record<string, StepStats>
  /** Rotating praise index. */
  praise: number
  /** Voice-only / switch users: "do it" is offered from the first hint level (T21). */
  offerEarly: boolean
  /** A spaced-repetition "prove it" run (T29): no pointing before the first hint. */
  review: boolean
  /** Opt-in idle hints (T33): hints come when the user is idle, not on the timer ladder. */
  idleHints: boolean
}

export type TimerId = 'hint' | 'timeout' | 'advance'

export type LessonEvent =
  | {
      type: 'start'
      lesson: Lesson
      skillId?: string | null
      source?: LessonSource
      /** Resume at this step (skips the intro). */
      stepIndex?: number
      autoStart?: boolean
      pace?: number
      stats?: Record<string, StepStats>
      offerEarly?: boolean
      review?: boolean
      idleHints?: boolean
    }
  | { type: 'command'; command: LessonCommand }
  /** The user has been idle in the lesson app (T33): the next hint, quietly unless voice. */
  | { type: 'idle'; voice: boolean }
  | { type: 'timer'; id: TimerId }
  /** forced = the answer to an "evaluate now" (after "done"). */
  | { type: 'check'; step: number; result: CheckResult; forced?: boolean }
  | { type: 'do-it-done'; step: number; ok: boolean; said?: string }
  /** The lesson app lost focus for over a minute. */
  | { type: 'app-blur' }
  /** Idle hints were switched off mid-lesson: the timer ladder takes over again. */
  | { type: 'idle-hints-off' }

export type LessonEffect =
  | { type: 'say'; text: string; interruptible: boolean }
  /** Resolve the step target and draw the scene for this hint level. */
  | { type: 'point'; step: number; level: number }
  | { type: 'scene'; scene: 'clear' | 'success' }
  | { type: 'assistant'; state: AssistantState | null }
  | { type: 'startChecks'; step: number }
  | { type: 'evaluate'; step: number }
  | { type: 'cancelChecks' }
  | { type: 'startTimer'; id: TimerId; ms: number }
  | { type: 'cancelTimer'; id: TimerId }
  | { type: 'persist' }
  /** perform = the user's "click it" (not counted as do-it-for-me, no "I did it" line). */
  | { type: 'exec'; step: number; perform?: boolean }
  /** Ask the model why the step matters (no `why` in the lesson), then say it. */
  | { type: 'explain'; step: number }
  | { type: 'event'; name: 'step-started' | 'step-completed'; step: number }
  | { type: 'event'; name: 'done'; step: number; completed: boolean }
  | { type: 'log'; msg: string }

export interface Transition {
  state: LessonState
  effects: LessonEffect[]
}

export const IDLE: LessonState = {
  phase: 'idle',
  lesson: null,
  skillId: null,
  source: 'pack',
  index: 0,
  level: 0,
  pace: 1,
  stats: {},
  praise: 0,
  offerEarly: false,
  review: false,
  idleHints: false
}

/** A lesson is on (the voice grammar and lesson context apply). */
export function isRunning(s: LessonState): boolean {
  return s.phase !== 'idle' && s.phase !== 'done' && s.phase !== 'aborted'
}
