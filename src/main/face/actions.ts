// Gesture → action (11 T25). Clicks and scrolls happen at the pointer through the same input
// path as dwell and switch (input lane, executor, policy gate with origin user-direct);
// switch presses go to the 06 scanner; dwell pause and voice reuse their own controls.
import type { FaceAction } from '@shared/config'
import type { InputStep } from '@shared/types'

/** Wheel notches per scroll gesture. */
export const SCROLL_NOTCHES = 3
/** A held scroll gesture scrolls again this often. */
export const SCROLL_REPEAT_MS = 500

export interface FaceActionDeps {
  /** Runs input at the pointer; false when it did not run (agent down, denied). */
  input(steps: InputStep[]): Promise<boolean>
  /** False when switch scanning is off. */
  switchPress(role: 'select' | 'next'): boolean
  /** Toggles the user's dwell pause; false when dwell is off. */
  toggleDwellPause(): boolean
  /** Starts listening, like the wake word. */
  voice(): void
}

export function inputSteps(a: FaceAction): InputStep[] | null {
  switch (a) {
    case 'click':
      return [{ t: 'click', button: 'left' }]
    case 'right-click':
      return [{ t: 'click', button: 'right' }]
    case 'double-click':
      return [{ t: 'click', button: 'left', count: 2 }]
    case 'scroll-up':
      return [{ t: 'scroll', dx: 0, dy: -SCROLL_NOTCHES }]
    case 'scroll-down':
      return [{ t: 'scroll', dx: 0, dy: SCROLL_NOTCHES }]
    default:
      return null
  }
}

export function isRepeatable(a: FaceAction): boolean {
  return a === 'scroll-up' || a === 'scroll-down'
}

export interface FaceActionResult {
  ok: boolean
  /** Why it did nothing, to tell the user. */
  why?: string
}

export async function runFaceAction(
  a: FaceAction,
  deps: FaceActionDeps
): Promise<FaceActionResult> {
  const steps = inputSteps(a)
  if (steps) return (await deps.input(steps)) ? { ok: true } : { ok: false }
  switch (a) {
    case 'switch-select':
    case 'switch-next':
      return deps.switchPress(a === 'switch-next' ? 'next' : 'select')
        ? { ok: true }
        : { ok: false, why: 'Switch scanning is off.' }
    case 'dwell-pause':
      return deps.toggleDwellPause() ? { ok: true } : { ok: false, why: 'Dwell click is off.' }
    case 'voice':
      deps.voice()
      return { ok: true }
    default:
      return { ok: false }
  }
}
