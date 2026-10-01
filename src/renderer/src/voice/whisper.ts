// Whisper mode (04 T40): quiet speech is made loud enough for speech recognition. The mic
// already runs Chromium's noise suppression and auto gain; on top of that the recording gets
// up to +18 dB of digital gain (never less than 1x) before it is encoded, and the speech
// threshold drops so soft words count as speech. The adaptive noise floor (vad/rms.ts) still
// keeps a fan or a room from holding a recording open.

/** Gain cap: +18 dB. More mostly lifts room noise. */
export const MAX_WHISPER_GAIN = 8
/** Level the loud end of the speech is lifted to (0..1 full scale). */
export const TARGET_PEAK = 0.6
/** Threshold factor and floor for the speech gate in whisper mode. */
export const WHISPER_THRESHOLD_FACTOR = 0.35
export const MIN_WHISPER_THRESHOLD = 0.008
/** The level meter is scaled up by this much so whispering still moves it. */
export const WHISPER_METER_GAIN = 3

export function whisperThreshold(threshold: number): number {
  return Math.max(MIN_WHISPER_THRESHOLD, threshold * WHISPER_THRESHOLD_FACTOR)
}

/** |sample| below which `share` of the samples lie (histogram, 1/1024 steps). */
export function absPercentile(samples: Float32Array, share: number): number {
  if (!samples.length) return 0
  const bins = new Uint32Array(1025)
  for (let i = 0; i < samples.length; i++) {
    const a = Math.min(1, Math.abs(samples[i]))
    bins[Math.round(a * 1024)]++
  }
  const want = Math.ceil(samples.length * share)
  let seen = 0
  for (let b = 0; b < bins.length; b++) {
    seen += bins[b]
    if (seen >= want) return b / 1024
  }
  return 1
}

/** The gain whisper mode applies to a recording: lifts the 99.5th percentile to the target. */
export function whisperGain(samples: Float32Array): number {
  const peak = absPercentile(samples, 0.995)
  if (peak <= 0) return 1
  return Math.max(1, Math.min(MAX_WHISPER_GAIN, TARGET_PEAK / peak))
}

/** A boosted copy; the few samples past full scale are soft-limited instead of clipped. */
export function boostQuiet(samples: Float32Array): Float32Array {
  const gain = whisperGain(samples)
  if (gain === 1) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = softLimit(samples[i] * gain)
  return out
}

/** Linear up to 0.9, then bends smoothly towards ±1. */
export function softLimit(v: number): number {
  const a = Math.abs(v)
  if (a <= 0.9) return v
  return Math.sign(v) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1))
}
