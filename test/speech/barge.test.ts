import { describe, expect, it } from 'vitest'
import {
  BARGE_SUSTAIN_MS,
  BargeDetector,
  PcmRing,
  blockRms,
  joinPcm
} from '../../src/renderer/src/voice/vad/barge'
import { prependPcm } from '../../src/renderer/src/voice/wav'

const feedFor = (d: BargeDetector, level: number, ms: number, block = 20): boolean[] =>
  Array.from({ length: ms / block }, () => d.feed(level, block))

describe('BargeDetector', () => {
  it('fires after 250 ms of sustained speech, not before', () => {
    const d = new BargeDetector(0.04)
    feedFor(d, 0.001, 400)
    const hits = feedFor(d, 0.2, Math.ceil(BARGE_SUSTAIN_MS / 20) * 20)
    expect(hits.slice(0, -1).every((h) => !h)).toBe(true)
    expect(hits.at(-1)).toBe(true)
  })

  it('ignores short bursts (a click, a cough)', () => {
    const d = new BargeDetector(0.04)
    feedFor(d, 0.001, 400)
    for (let i = 0; i < 5; i++) {
      expect(feedFor(d, 0.2, 100).some(Boolean)).toBe(false)
      feedFor(d, 0.001, 200)
    }
  })

  it('bridges the short dips between syllables', () => {
    const d = new BargeDetector(0.04)
    feedFor(d, 0.001, 400)
    feedFor(d, 0.2, 160)
    feedFor(d, 0.001, 40)
    expect(feedFor(d, 0.2, 100).some(Boolean)).toBe(true)
  })

  it('stays quiet under the user threshold', () => {
    const d = new BargeDetector(0.04)
    expect(feedFor(d, 0.03, 2000).some(Boolean)).toBe(false)
  })
})

describe('PcmRing', () => {
  it('keeps the newest samples, oldest first', () => {
    const r = new PcmRing(4)
    r.push(Int16Array.from([1, 2, 3]))
    expect(Array.from(r.take(), (v) => Math.round(v * 0x8000))).toEqual([1, 2, 3])
    r.push(Int16Array.from([4, 5, 6]))
    expect(Array.from(r.take(), (v) => Math.round(v * 0x8000))).toEqual([3, 4, 5, 6])
  })
})

describe('pcm helpers', () => {
  it('joins pre-roll and the blocks after it', () => {
    const out = joinPcm(Float32Array.from([0.5]), [
      Int16Array.from([0x4000]),
      Int16Array.from([-0x8000])
    ])
    expect(Array.from(out)).toEqual([0.5, 0.5, -1])
  })
  it('measures block level', () => {
    expect(blockRms(new Int16Array(0))).toBe(0)
    expect(blockRms(Int16Array.from([0x4000, -0x4000]))).toBeCloseTo(0.5)
  })
  it('puts pre-roll in front of the recording', () => {
    const body = Float32Array.from([1])
    expect(prependPcm(undefined, body)).toBe(body)
    expect(Array.from(prependPcm(Float32Array.from([0.25]), body))).toEqual([0.25, 1])
  })
})
