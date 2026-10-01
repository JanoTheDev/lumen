import { describe, expect, it } from 'vitest'
import type { FaceFrame } from '@shared/channels'
import { GestureDetector, type DetectorOptions } from '../../src/main/face/detector'
import {
  DEFAULT_THRESHOLDS,
  boundGestures,
  releaseLevel,
  strength,
  thresholdsOf
} from '../../src/main/face/gestures'
import { FACE_DEFAULTS } from '@shared/config'

const frame = (p: Partial<FaceFrame> = {}): FaceFrame => ({
  face: true,
  mouthOpen: 0,
  browRaise: 0,
  smile: 0,
  roll: 0,
  yaw: 0,
  ...p
})

const opts = (o: Partial<DetectorOptions> = {}): DetectorOptions => ({
  holdMs: 300,
  cooldownMs: 800,
  thresholds: DEFAULT_THRESHOLDS,
  active: ['mouthOpen', 'browRaise', 'tiltLeft', 'tiltRight'],
  ...o
})

/** Feeds `f` every 66 ms from `from` to `to`; returns [time, gesture] of each hit. */
function feed(d: GestureDetector, f: FaceFrame, from: number, to: number): [number, string][] {
  const out: [number, string][] = []
  for (let t = from; t <= to; t += 66) {
    const g = d.step(f, t)
    if (g) out.push([t, g])
  }
  return out
}

describe('face gestures: thresholds', () => {
  it('uses defaults until calibrated and ignores an inverted calibration', () => {
    const t = thresholdsOf({
      thresholds: {
        mouthOpen: { on: 0.3, rest: 0.02, dir: 1 },
        smile: { on: 0.1, rest: 0.2, dir: 1 }
      }
    })
    expect(t.mouthOpen.on).toBe(0.3)
    expect(t.smile).toEqual(DEFAULT_THRESHOLDS.smile)
    expect(t.browRaise).toEqual(DEFAULT_THRESHOLDS.browRaise)
  })

  it('projects head angles by direction', () => {
    const left = DEFAULT_THRESHOLDS.tiltLeft
    expect(strength('tiltLeft', frame({ roll: -15 }), left)).toBeCloseTo(1)
    expect(strength('tiltLeft', frame({ roll: 15 }), left)).toBeLessThan(0)
    expect(releaseLevel({ on: 10, rest: 0, dir: 1 })).toBeCloseTo(7)
  })

  it('lists only bound gestures', () => {
    expect(boundGestures(FACE_DEFAULTS)).toEqual(['mouthOpen', 'browRaise', 'tiltRight'])
  })
})

describe('face gestures: detector', () => {
  it('acts once after the hold time, not on a short twitch', () => {
    const d = new GestureDetector(opts())
    expect(feed(d, frame({ mouthOpen: 0.8 }), 0, 200)).toEqual([])
    expect(feed(d, frame(), 266, 400)).toEqual([])
    const hits = feed(d, frame({ mouthOpen: 0.8 }), 1000, 3000)
    expect(hits).toHaveLength(1)
    expect(hits[0][1]).toBe('mouthOpen')
    expect(hits[0][0] - 1000).toBeGreaterThanOrEqual(300)
  })

  it('re-arms only after falling under the release level', () => {
    const d = new GestureDetector(opts({ cooldownMs: 0 }))
    expect(feed(d, frame({ mouthOpen: 0.8 }), 0, 500)).toHaveLength(1)
    // 0.35 is under on (0.45) but above release (0.05 + 0.7 * 0.4 = 0.33): still latched.
    feed(d, frame({ mouthOpen: 0.35 }), 566, 700)
    expect(feed(d, frame({ mouthOpen: 0.8 }), 766, 1500)).toEqual([])
    feed(d, frame({ mouthOpen: 0.1 }), 1566, 1700)
    expect(feed(d, frame({ mouthOpen: 0.8 }), 1766, 2500)).toHaveLength(1)
  })

  it('keeps the cooldown between different gestures', () => {
    const d = new GestureDetector(opts({ cooldownMs: 2000 }))
    expect(feed(d, frame({ mouthOpen: 0.8 }), 0, 400)).toHaveLength(1)
    const hits = feed(d, frame({ mouthOpen: 0.8, roll: 20 }), 466, 3000)
    expect(hits.map((h) => h[1])).toEqual(['tiltRight'])
    expect(hits[0][0]).toBeGreaterThanOrEqual(2000)
  })

  it('picks the strongest of two gestures held together', () => {
    const d = new GestureDetector(opts())
    const hits = feed(d, frame({ mouthOpen: 0.5, browRaise: 0.95 }), 0, 400)
    expect(hits.map((h) => h[1])).toEqual(['browRaise'])
  })

  it('repeats a held repeatable gesture', () => {
    const d = new GestureDetector(opts({ repeatMs: { browRaise: 500 } }))
    const hits = feed(d, frame({ browRaise: 0.9 }), 0, 2000)
    expect(hits.length).toBeGreaterThanOrEqual(3)
    expect(hits.every((h) => h[1] === 'browRaise')).toBe(true)
  })

  it('ignores unbound gestures and resets when the face is lost', () => {
    const d = new GestureDetector(opts({ active: ['mouthOpen'] }))
    expect(feed(d, frame({ smile: 1, roll: 30 }), 0, 1000)).toEqual([])
    feed(d, frame({ mouthOpen: 0.8 }), 1066, 1250)
    d.step({ ...frame(), face: false }, 1300)
    // The hold starts over after the face comes back.
    expect(d.step(frame({ mouthOpen: 0.8 }), 1366)).toBeNull()
    expect(d.step(frame({ mouthOpen: 0.8 }), 1500)).toBeNull()
    expect(d.step(frame({ mouthOpen: 0.8 }), 1700)).toBe('mouthOpen')
  })
})
