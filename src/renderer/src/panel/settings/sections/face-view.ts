// Settings → Accessibility → face gestures (11 T25): labels and the calibration plan.
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
  { value: 'voice', label: 'Start listening' }
]

/** Wizard steps: the resting face, then every gesture that does something. */
export type CalibrationStep = { kind: 'rest' } | { kind: 'gesture'; gesture: FaceGesture }

export function calibrationPlan(cfg: Pick<FaceConfig, 'bindings'>): CalibrationStep[] {
  return [
    { kind: 'rest' },
    ...FACE_GESTURES.filter((g) => cfg.bindings[g] !== 'none').map((gesture) => ({
      kind: 'gesture' as const,
      gesture
    }))
  ]
}

export function stepPrompt(step: CalibrationStep): string {
  return step.kind === 'rest'
    ? 'Relax your face and look at the screen.'
    : FACE_GESTURE_PROMPT[step.gesture]
}
