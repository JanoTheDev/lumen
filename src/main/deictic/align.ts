// When was each word said (11 T15)? With STT word timestamps they are used as they are; the
// local and cloud engines Lumen uses return text only, so the times are estimated from the
// utterance's start and end (recording start / stop) by spreading the words over the speech by
// their length, after a short lead-in and before a short tail of silence. No Electron.

export interface UtteranceTiming {
  /** Recording started (ms). */
  start: number
  /** Recording stopped (ms). */
  end: number
  /** Per-word [start, end] from the STT engine, when it has them. */
  words?: { start: number; end: number }[]
}

/** Silence before the first word / after the last, when the utterance is long enough. */
export const LEAD_MS = 300
export const TAIL_MS = 250

export interface WordTime {
  /** Middle of the word. */
  t: number
  /** How far off the estimate may be (search window half-width). */
  slack: number
}

export function wordTimes(words: string[], timing: UtteranceTiming): WordTime[] {
  const exact = timing.words
  if (exact && exact.length === words.length)
    return exact.map((w) => ({ t: (w.start + w.end) / 2, slack: 350 }))
  const total = Math.max(0, timing.end - timing.start)
  const pad = total > 1500 ? LEAD_MS + TAIL_MS : 0
  const span = total - pad
  const from = timing.start + (pad ? LEAD_MS : 0)
  // Each word weighs its letters plus one for the gap after it.
  const weights = words.map((w) => w.length + 1)
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const perWord = span / Math.max(1, words.length)
  let before = 0
  return words.map((_, i) => {
    const t = from + ((before + weights[i] / 2) / sum) * span
    before += weights[i]
    return { t, slack: Math.max(450, perWord * 1.5) }
  })
}
