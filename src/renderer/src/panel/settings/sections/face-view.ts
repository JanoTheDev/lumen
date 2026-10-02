// Settings → Accessibility → face gestures (11 T25): labels and the calibration plan.
import type { FaceRangeAt } from '@shared/channels'
import { FACE_GESTURES, type FaceAction, type FaceConfig, type FaceGesture } from '@shared/config'

export const FACE_GESTURE_LABEL: Record<FaceGesture, string> = {
  mouthOpen: 'Open mouth',
  browRaise: 'Raise eyebrows',
  smile: 'Smile',
  tiltLeft: 'Tilt head left',
  tiltRight: 'Tilt head right',
  turnLeft: 'Turn head left',
  turnRight: 'Turn head right'
}

/** What the wizard asks the user to do and hold. */
export const FACE_GESTURE_PROMPT: Record<FaceGesture, string> = {
  mouthOpen: 'Open your mouth and keep it open.',
  browRaise: 'Raise your eyebrows and keep them up.',
  smile: 'Smile and hold it.',
  tiltLeft: 'Tilt your head toward your left shoulder and hold it.',
  tiltRight: 'Tilt your head toward your right shoulder and hold it.',
  turnLeft: 'Turn your head to the left and hold it.',
  turnRight: 'Turn your head to the right and hold it.'
}

export const FACE_ACTION_OPTIONS: { value: FaceAction; label: string }[] = [
  { value: 'none', label: 'Nothing' },
  { value: 'click', label: 'Click' },
  { value: 'right-click', label: 'Right-click' },
  { value: 'double-click', label: 'Double-click' },
  { value: 'scroll-up', label: 'Scroll up' },
  { value: 'scroll-down', label: 'Scroll down' },
  { value: 'switch-select', label: 'Switch: pick' },
  { value: 'switch-next', label: 'Switch: next' },
  { value: 'dwell-pause', label: 'Pause or resume dwell' },
  { value: 'voice', label: 'Start listening' },
  { value: 'pointer-pause', label: 'Pause or resume head pointer' },
  { value: 'pointer-recentre', label: 'Recentre head pointer' }
]

/** Turning the head moves the head pointer, so these gestures do nothing while it is on. */
export const POINTER_GESTURES: readonly FaceGesture[] = ['turnLeft', 'turnRight']

export const RANGE_STEPS: readonly FaceRangeAt[] = ['centre', 'left', 'right', 'up', 'down']

const RANGE_PROMPT: Record<FaceRangeAt, string> = {
  centre: 'Look at the centre of the screen and keep still.',
  left: 'Turn your head to look at the left edge of the screen and hold it.',
  right: 'Turn your head to look at the right edge of the screen and hold it.',
  up: 'Look up at the top edge of the screen and hold it.',
  down: 'Look down at the bottom edge of the screen and hold it.'
}

/** Wizard steps: the resting face, then every gesture that does something. */
export type CalibrationStep =
  | { kind: 'rest' }
  | { kind: 'gesture'; gesture: FaceGesture }
  | { kind: 'range'; at: FaceRangeAt }

/** The head pointer's range steps: centre, left, right, top, bottom. */
export function rangePlan(): CalibrationStep[] {
  return RANGE_STEPS.map((at) => ({ kind: 'range' as const, at }))
}

/**
 * The resting face, then every gesture that does something (not head turns while the head
 * pointer is on), then the head pointer's range when it is on.
 */
export function calibrationPlan(
  cfg: Pick<FaceConfig, 'bindings'> & { pointer?: Pick<FaceConfig['pointer'], 'enabled'> }
): CalibrationStep[] {
  const pointer = !!cfg.pointer?.enabled
  return [
    { kind: 'rest' },
    ...FACE_GESTURES.filter(
      (g) => cfg.bindings[g] !== 'none' && !(pointer && POINTER_GESTURES.includes(g))
    ).map((gesture) => ({
      kind: 'gesture' as const,
      gesture
    })),
    ...(pointer ? rangePlan() : [])
  ]
}

export function stepPrompt(step: CalibrationStep): string {
  if (step.kind === 'rest') return 'Relax your face and look at the screen.'
  if (step.kind === 'range') return RANGE_PROMPT[step.at]
  return FACE_GESTURE_PROMPT[step.gesture]
}

/** Preview dot position in a box of `size` px: offset -1..1 → 0..size, clamped. */
export function previewDot(n: number, size: number): number {
  const c = Math.min(1, Math.max(-1, n))
  return Math.round(((c + 1) / 2) * size)
}
