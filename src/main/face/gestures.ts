// Face gestures (11 T25): which score each gesture reads and the built-in thresholds used
// until the user calibrates. Scores come from the face renderer: blendshapes 0..1 and head
// roll / yaw in degrees. Thresholds live in "projected" units (score * dir), so one rule
// works for both: active at proj >= on, re-armed below rest + RELEASE of the way to on.
import type { FaceFrame } from '@shared/channels'
import {
  FACE_GESTURES,
  type FaceConfig,
  type FaceGesture,
  type FaceThreshold
} from '@shared/config'

/** Share of the rest → on gap a gesture must fall back under before it can act again. */
export const RELEASE = 0.7

export type GestureKind = 'level' | 'angle'

export const GESTURE_KIND: Record<FaceGesture, GestureKind> = {
  mouthOpen: 'level',
  browRaise: 'level',
  smile: 'level',
  tiltLeft: 'angle',
  tiltRight: 'angle',
  turnLeft: 'angle',
  turnRight: 'angle'
}

/** Spoken / shown names. */
export const GESTURE_LABEL: Record<FaceGesture, string> = {
  mouthOpen: 'Open mouth',
  browRaise: 'Raise eyebrows',
  smile: 'Smile',
  tiltLeft: 'Tilt head left',
  tiltRight: 'Tilt head right',
  turnLeft: 'Turn head left',
  turnRight: 'Turn head right'
}

/**
 * Defaults before calibration. Head directions follow the renderer's sign convention
 * (positive roll / yaw = the user's right); calibration learns the real direction.
 */
export const DEFAULT_THRESHOLDS: Record<FaceGesture, FaceThreshold> = {
  mouthOpen: { on: 0.45, rest: 0.05, dir: 1 },
  browRaise: { on: 0.5, rest: 0.1, dir: 1 },
  smile: { on: 0.6, rest: 0.1, dir: 1 },
  tiltLeft: { on: 15, rest: 0, dir: -1 },
  tiltRight: { on: 15, rest: 0, dir: 1 },
  turnLeft: { on: 20, rest: 0, dir: -1 },
  turnRight: { on: 20, rest: 0, dir: 1 }
}

/** The raw score a gesture reads from a frame. */
export function gestureScore(g: FaceGesture, f: FaceFrame): number {
  switch (g) {
    case 'mouthOpen':
      return f.mouthOpen
    case 'browRaise':
      return f.browRaise
    case 'smile':
      return f.smile
    case 'tiltLeft':
    case 'tiltRight':
      return f.roll
    case 'turnLeft':
    case 'turnRight':
      return f.yaw
  }
}

export function thresholdsOf(
  cfg: Pick<FaceConfig, 'thresholds'>
): Record<FaceGesture, FaceThreshold> {
  const out = { ...DEFAULT_THRESHOLDS }
  for (const g of FACE_GESTURES) {
    const t = cfg.thresholds[g]
    if (t && t.on > t.rest) out[g] = t
  }
  return out
}

export function project(g: FaceGesture, f: FaceFrame, t: FaceThreshold): number {
  return gestureScore(g, f) * t.dir
}

export function releaseLevel(t: FaceThreshold): number {
  return t.rest + RELEASE * (t.on - t.rest)
}

/** 0 at rest, 1 at the threshold, more when held further. */
export function strength(g: FaceGesture, f: FaceFrame, t: FaceThreshold): number {
  const gap = t.on - t.rest
  return gap > 0 ? (project(g, f, t) - t.rest) / gap : 0
}

/** Gestures bound to an action. */
export function boundGestures(cfg: Pick<FaceConfig, 'bindings'>): FaceGesture[] {
  return FACE_GESTURES.filter((g) => cfg.bindings[g] !== 'none')
}
