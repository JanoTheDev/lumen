import { describe, expect, it } from 'vitest'
import {
  MAX_WHISPER_GAIN,
  absPercentile,
  boostQuiet,
  softLimit,
  whisperGain,
  whisperThreshold
} from '../../src/renderer/src/voice/whisper'
import { RmsGate } from '../../src/renderer/src/voice/vad/rms'
import { earconTones } from '../../src/renderer/src/voice/earcons'
import { DEFAULT_EXTRAS, readExtras } from '../../src/renderer/src/voice/extras'

/** Deterministic noise in [-1, 1]. */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0xffffffff) * 2 - 1
  }
}

function sine(amp: number, n = 16000): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / 16000)
  return out
}

describe('whisper gain (04 T40)', () => {
  it('lifts quiet speech, capped at +18 dB', () => {
    const quiet = sine(0.05)
    const g = whisperGain(quiet)
    expect(g).toBeGreaterThan(5)
    expect(g).toBeLessThanOrEqual(MAX_WHISPER_GAIN)
    const out = boostQuiet(quiet)
    expect(absPercentile(out, 0.995)).toBeGreaterThan(0.3)
    expect(whisperGain(sine(0.001))).toBe(MAX_WHISPER_GAIN)
  })

  it('never turns normal speech down and leaves it untouched', () => {
    const loud = sine(0.8)
    expect(whisperGain(loud)).toBe(1)
    expect(boostQuiet(loud)).toBe(loud)
    expect(whisperGain(new Float32Array(100))).toBe(1)
  })

  it('soft-limits instead of clipping', () => {
    expect(softLimit(0.5)).toBe(0.5)
    expect(softLimit(3)).toBeLessThanOrEqual(1)
    expect(softLimit(-3)).toBeGreaterThanOrEqual(-1)
    expect(softLimit(0.95)).toBeGreaterThan(0.9)
  })

  it('lower threshold, with a floor', () => {
    expect(whisperThreshold(0.04)).toBeCloseTo(0.014)
    expect(whisperThreshold(0.01)).toBe(0.008)
  })
})

describe('whisper mode false triggers', () => {
  const ticks = (g: RmsGate, levels: number[]): number => levels.filter((l) => g.update(l)).length

  it('a quiet room never counts as speech', () => {
    const r = rng(7)
    const g = new RmsGate({ threshold: whisperThreshold(0.04) })
    const room = Array.from({ length: 2000 }, () => 0.004 + 0.002 * r())
    expect(ticks(g, room)).toBe(0)
  })

  it('steady fan noise above the whisper threshold is learned within seconds', () => {
    const r = rng(11)
    const g = new RmsGate({ threshold: whisperThreshold(0.04) })
    const fan = Array.from({ length: 2000 }, () => 0.02 + 0.003 * r())
    const hits = fan.map((l) => g.update(l))
    // ~80 ms ticks: after 5 s (60 ticks) the fan no longer counts.
    expect(hits.slice(60).filter(Boolean).length).toBe(0)
  })

  it('a whisper in a quiet room is heard', () => {
    const g = new RmsGate({ threshold: whisperThreshold(0.04) })
    for (let i = 0; i < 50; i++) g.update(0.004)
    expect(g.update(0.025)).toBe(true)
    // The normal threshold would have missed it.
    const normal = new RmsGate({ threshold: 0.04 })
    for (let i = 0; i < 50; i++) normal.update(0.004)
    expect(normal.update(0.025)).toBe(false)
  })
})

describe('dictation sounds and settings (04 T47/T48)', () => {
  it('short rising start and falling stop', () => {
    const start = earconTones('start')
    const stop = earconTones('stop')
    expect(start[1].freq).toBeGreaterThan(start[0].freq)
    expect(stop[1].freq).toBeLessThan(stop[0].freq)
    for (const t of [...start, ...stop]) expect(t.at + t.dur).toBeLessThanOrEqual(0.2)
  })

  it('quiet mode silences the sounds; defaults for old configs', () => {
    expect(readExtras(null)).toEqual(DEFAULT_EXTRAS)
    const cfg = {
      voice: { whisperMode: true },
      dictation: { sounds: true, caretPill: false, silenceSec: 3.5 },
      agent: { background: { quiet: true } }
    }
    expect(readExtras(cfg)).toEqual({
      whisper: true,
      sounds: false,
      pill: false,
      dictationSilenceMs: 3500
    })
  })
})
