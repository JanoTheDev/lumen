import { describe, expect, it } from 'vitest'
import { calibrate, calibrationMessage, percentile } from '../../src/main/face/calibrate'

const noisy = (center: number, spread: number, n = 30): number[] =>
  Array.from({ length: n }, (_, i) => center + spread * Math.sin(i * 1.7))

describe('face calibration', () => {
  it('percentile handles empty and edges', () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([3, 1, 2], 0)).toBe(1)
    expect(percentile([3, 1, 2], 1)).toBe(3)
    expect(percentile([3, 1, 2], 0.5)).toBe(2)
  })

  it('sets a level threshold between rest and the held gesture', () => {
    const r = calibrate(noisy(0.05, 0.03), noisy(0.7, 0.1), 'level')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.threshold.dir).toBe(1)
    expect(r.threshold.on).toBeGreaterThan(0.08)
    expect(r.threshold.on).toBeLessThan(0.6)
    expect(r.threshold.rest).toBeCloseTo(0.05, 1)
  })

  it('learns the direction of a head angle', () => {
    const r = calibrate(noisy(2, 1.5), noisy(-20, 3), 'angle')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.threshold.dir).toBe(-1)
    // Projected: rest about -2, held about 20.
    expect(r.threshold.on).toBeGreaterThan(3)
    expect(r.threshold.on).toBeLessThan(17)
  })

  it('refuses gestures too close to rest, the wrong way, or too few frames', () => {
    expect(calibrate(noisy(0.1, 0.05), noisy(0.15, 0.05), 'level')).toEqual({
      ok: false,
      reason: 'too-small'
    })
    expect(calibrate(noisy(0.4, 0.02), noisy(0.1, 0.02), 'level')).toEqual({
      ok: false,
      reason: 'wrong-way'
    })
    expect(calibrate(noisy(0, 1, 5), noisy(30, 1), 'angle')).toEqual({
      ok: false,
      reason: 'few-samples'
    })
    expect(calibrationMessage('too-small')).toMatch(/bigger movement/)
  })
})
