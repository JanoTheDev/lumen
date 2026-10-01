// Lesson engine state, events and effects (plans 07 lesson-engine.md). The reducer in
// engine.ts maps (state, event) to (state, effects); runner.ts executes the effects.
// Pure types: no Electron.
import type { AssistantState } from '@shared/events'
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

export const LESSON_COMMANDS: readonly LessonCommand[] = [
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
  'no'
]

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
  startedAt: number
  stats: Record<string, StepStats>
  /** Rotating praise index. */
  praise: number
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
    }
  | { type: 'command'; command: LessonCommand }
  | { type: 'timer'; id: TimerId }
  /** forced = the answer to an "evaluate now" (after "done"). */
  | { type: 'check'; step: number; result: CheckResult; forced?: boolean }
  | { type: 'do-it-done'; step: number; ok: boolean; said?: string }
  /** The lesson app lost focus for over a minute. */
  | { type: 'app-blur' }

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
  | { type: 'exec'; step: number }
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
  startedAt: 0,
  stats: {},
  praise: 0
}

/** A lesson is on (the voice grammar and lesson context apply). */
export function isRunning(s: LessonState): boolean {
  return s.phase !== 'idle' && s.phase !== 'done' && s.phase !== 'aborted'
}
