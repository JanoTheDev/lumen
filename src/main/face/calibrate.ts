// Calibration math (11 T25): a threshold from two short samples of one score, the resting
// face and the held gesture. The direction comes from the data (which way the score moved),
// the threshold sits halfway between the top of the resting values and the held gesture.
import type { FaceThreshold } from '@shared/config'
import type { GestureKind } from './gestures'

/** Frames each sample needs (about 1 s at 15 fps). */
export const MIN_SAMPLES = 10
/** Smallest gap between rest and gesture that still separates them reliably. */
export const MIN_GAP: Record<GestureKind, number> = { level: 0.1, angle: 6 }

export type CalibrationOutcome =
  | { ok: true; threshold: FaceThreshold }
  | { ok: false; reason: 'few-samples' | 'too-small' | 'wrong-way' }

export function percentile(values: readonly number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))
  return s[i]
}

const round = (n: number, kind: GestureKind): number =>
  kind === 'angle' ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 1000

/**
 * `rest` and `active` are raw scores of one gesture. Level gestures (blendshapes) must rise;
 * angle gestures may go either way and learn `dir`.
 */
export function calibrate(
  rest: readonly number[],
  active: readonly number[],
  kind: GestureKind
): CalibrationOutcome {
  if (rest.length < MIN_SAMPLES || active.length < MIN_SAMPLES) {
    return { ok: false, reason: 'few-samples' }
  }
  const moved = percentile(active, 0.5) - percentile(rest, 0.5)
  if (kind === 'level' && moved <= 0) return { ok: false, reason: 'wrong-way' }
  const dir: 1 | -1 = moved >= 0 ? 1 : -1
  const restP = rest.map((v) => v * dir)
  const activeP = active.map((v) => v * dir)
  const restHigh = percentile(restP, 0.95)
  // The lower part of the held sample: the gesture must work even when held less fully.
  const held = percentile(activeP, 0.4)
  const gap = held - restHigh
  if (gap < MIN_GAP[kind]) return { ok: false, reason: 'too-small' }
  return {
    ok: true,
    threshold: {
      on: round(restHigh + gap / 2, kind),
      rest: round(percentile(restP, 0.5), kind),
      dir
    }
  }
}

export function calibrationMessage(reason: 'few-samples' | 'too-small' | 'wrong-way'): string {
  switch (reason) {
    case 'few-samples':
      return 'I could not see your face long enough. Check the light and face the camera, then try again.'
    case 'too-small':
      return 'That looked too close to your resting face. Try a bigger movement and hold it.'
    case 'wrong-way':
      return 'That moved the wrong way. Do the gesture and hold it while I count.'
  }
}
