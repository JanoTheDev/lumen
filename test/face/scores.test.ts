import { describe, expect, it } from 'vitest'
import { headAngles, NO_FACE, toFrame } from '../../src/renderer/src/face/scores'
import {
  calibrationPlan,
  stepPrompt
} from '../../src/renderer/src/panel/settings/sections/face-view'
import { FACE_DEFAULTS, configV2Schema, DEFAULT_CONFIG_V2 } from '@shared/config'
import { faceCalibrateSchema, faceFrameSchema } from '@shared/ipc'

/** Column-major 4x4 for a rotation about z (roll) by `deg`. */
function rollMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Column-major 4x4 for a rotation about y (yaw) by `deg`. */
function yawMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

describe('face scores', () => {
  it('reads roll and yaw from the transformation matrix', () => {
    expect(headAngles(rollMatrix(20)).roll).toBeCloseTo(20)
    expect(headAngles(rollMatrix(20)).yaw).toBeCloseTo(0)
    expect(headAngles(yawMatrix(-15)).yaw).toBeCloseTo(-15)
    expect(headAngles([1, 2])).toEqual({ roll: 0, yaw: 0 })
  })

  it('turns blendshapes into a frame, no face without them', () => {
    expect(toFrame(undefined, undefined)).toBe(NO_FACE)
    const f = toFrame(
      [
        { categoryName: 'jawOpen', score: 0.61234 },
        { categoryName: 'browInnerUp', score: 0.2 },
        { categoryName: 'browOuterUpLeft', score: 0.5 },
        { categoryName: 'browOuterUpRight', score: 0.7 },
        { categoryName: 'mouthSmileLeft', score: 0.4 },
        { categoryName: 'mouthSmileRight', score: 0.6 }
      ],
      rollMatrix(10)
    )
    expect(f.face).toBe(true)
    expect(f.mouthOpen).toBeCloseTo(0.612, 3)
    expect(f.browRaise).toBeCloseTo(0.6)
    expect(f.smile).toBeCloseTo(0.5)
    expect(f.roll).toBeCloseTo(10)
    expect(faceFrameSchema.safeParse(f).success).toBe(true)
  })

  it('frames carry numbers only', () => {
    expect(faceFrameSchema.safeParse({ ...NO_FACE, image: 'x' }).success).toBe(false)
    expect(faceCalibrateSchema.safeParse({ step: 'gesture', gesture: 'wink' }).success).toBe(false)
    expect(faceCalibrateSchema.safeParse({ step: 'rest' }).success).toBe(true)
  })
})

describe('face config and wizard', () => {
  it('is off by default and old configs gain it', () => {
    expect(DEFAULT_CONFIG_V2.a11y.face.enabled).toBe(false)
    const { face: _drop, ...a11y } = DEFAULT_CONFIG_V2.a11y
    void _drop
    const parsed = configV2Schema.parse({ ...DEFAULT_CONFIG_V2, a11y })
    expect(parsed.a11y.face).toEqual(FACE_DEFAULTS)
  })

  it('calibrates the resting face, then each bound gesture', () => {
    const plan = calibrationPlan(FACE_DEFAULTS)
    expect(plan).toEqual([
      { kind: 'rest' },
      { kind: 'gesture', gesture: 'mouthOpen' },
      { kind: 'gesture', gesture: 'browRaise' },
      { kind: 'gesture', gesture: 'tiltRight' }
    ])
    expect(stepPrompt(plan[1])).toMatch(/Open your mouth/)
  })
})
