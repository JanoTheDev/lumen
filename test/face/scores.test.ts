import { describe, expect, it } from 'vitest'
import { headAngles, NO_FACE, toFrame } from '../../src/renderer/src/face/scores'
import {
  calibrationPlan,
  previewDot,
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
    expect(headAngles([1, 2])).toEqual({ roll: 0, yaw: 0, pitch: 0 })
  })

  it('reads pitch from the transformation matrix', () => {
    // Rotation about x by 12 degrees, column-major.
    const a = (12 * Math.PI) / 180
    const m = [
      1,
      0,
      0,
      0,
      0,
      Math.cos(a),
      Math.sin(a),
      0,
      0,
      -Math.sin(a),
      Math.cos(a),
      0,
      0,
      0,
      0,
      1
    ]
    const h = headAngles(m)
    expect(h.pitch).toBeCloseTo(12)
    expect(h.yaw).toBeCloseTo(0)
    expect(h.roll).toBeCloseTo(0)
    expect(headAngles(yawMatrix(20)).pitch).toBeCloseTo(0)
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
    expect(faceCalibrateSchema.safeParse({ step: 'range', at: 'left' }).success).toBe(true)
    expect(faceCalibrateSchema.safeParse({ step: 'range', at: 'nose' }).success).toBe(false)
    const { pitch: _p, ...noPitch } = NO_FACE
    void _p
    expect(faceFrameSchema.safeParse(noPitch).success).toBe(false)
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

  it('adds the pointer range and skips head turns while the head pointer is on', () => {
    expect(DEFAULT_CONFIG_V2.a11y.face.pointer.enabled).toBe(false)
    const plan = calibrationPlan({
      bindings: { ...FACE_DEFAULTS.bindings, turnLeft: 'click' },
      pointer: { enabled: true }
    })
    expect(plan.some((s) => s.kind === 'gesture' && s.gesture === 'turnLeft')).toBe(false)
    expect(plan.slice(-5).map((s) => (s.kind === 'range' ? s.at : s.kind))).toEqual([
      'centre',
      'left',
      'right',
      'up',
      'down'
    ])
    expect(stepPrompt(plan[plan.length - 1])).toMatch(/bottom edge/)
    expect(previewDot(0, 120)).toBe(60)
    expect(previewDot(-3, 120)).toBe(0)
    expect(previewDot(1, 120)).toBe(120)
  })

  it('resets calibration and the pointer range with null', () => {
    const face = {
      ...FACE_DEFAULTS,
      thresholds: { smile: null },
      pointer: { ...FACE_DEFAULTS.pointer, range: null }
    }
    const parsed = configV2Schema.parse({
      ...DEFAULT_CONFIG_V2,
      a11y: { ...DEFAULT_CONFIG_V2.a11y, face }
    })
    expect(parsed.a11y.face.thresholds.smile).toBeNull()
    expect(parsed.a11y.face.pointer.range).toBeNull()
  })
})
