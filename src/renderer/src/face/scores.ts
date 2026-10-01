// Face Landmarker result → the few numbers main needs (11 T25). Nothing else leaves the
// face renderer: no image, no landmarks.
import type { FaceFrame } from '@shared/channels'

export interface Blendshape {
  categoryName: string
  score: number
}

export const NO_FACE: FaceFrame = {
  face: false,
  mouthOpen: 0,
  browRaise: 0,
  smile: 0,
  roll: 0,
  yaw: 0
}

const DEG = 180 / Math.PI
const round = (n: number, step: number): number => Math.round(n / step) * step

/**
 * Head roll and yaw in degrees from the 4x4 facial transformation matrix (column-major, as
 * MediaPipe returns it). Positive = toward the user's right on a mirrored camera image;
 * calibration learns the real direction, so only consistency matters.
 */
export function headAngles(m: ArrayLike<number>): { roll: number; yaw: number } {
  if (m.length < 16) return { roll: 0, yaw: 0 }
  // Row-major r[i][j] = m[j * 4 + i].
  const r00 = m[0]
  const r10 = m[1]
  const r20 = m[2]
  const r21 = m[6]
  const r22 = m[10]
  const roll = Math.atan2(r10, r00) * DEG
  const yaw = Math.atan2(-r20, Math.hypot(r21, r22)) * DEG
  return { roll, yaw }
}

export function toFrame(
  shapes: readonly Blendshape[] | undefined,
  matrix: ArrayLike<number> | undefined
): FaceFrame {
  if (!shapes?.length) return NO_FACE
  const s = (name: string): number => shapes.find((c) => c.categoryName === name)?.score ?? 0
  const outer = (s('browOuterUpLeft') + s('browOuterUpRight')) / 2
  const { roll, yaw } = matrix ? headAngles(matrix) : { roll: 0, yaw: 0 }
  return {
    face: true,
    mouthOpen: round(s('jawOpen'), 0.001),
    browRaise: round(Math.max(s('browInnerUp'), outer), 0.001),
    smile: round((s('mouthSmileLeft') + s('mouthSmileRight')) / 2, 0.001),
    roll: round(roll, 0.1),
    yaw: round(yaw, 0.1)
  }
}
