// Dwell arc smoothing (motion.md §3): progress samples arrive at ~25 Hz; between them the
// arc keeps moving at the last measured rate so it looks continuous at the display's
// refresh rate. A drop in progress (cancel / reset) retracts over 120ms instead of jumping.

export const RETRACT_MS = 120
/** Never run ahead of the last sample by more than this (a missed sample must not overshoot). */
const MAX_LEAD = 0.08
const MAX_GAP_MS = 120

export interface DwellInterp {
  /** Last sample and when it arrived. */
  p: number
  t: number
  /** Progress per ms from the last two samples. */
  rate: number
  /** Retract start (shown value and time) after a drop; null otherwise. */
  retract: { from: number; t: number } | null
}

export const initialInterp = (): DwellInterp => ({ p: 0, t: 0, rate: 0, retract: null })

export function addSample(s: DwellInterp, p: number, now: number, shown: number): DwellInterp {
  const clamped = Math.max(0, Math.min(1, p))
  if (clamped < s.p - 1e-3) {
    return { p: clamped, t: now, rate: 0, retract: { from: shown, t: now } }
  }
  const dt = now - s.t
  const rate = dt > 0 && dt < 500 ? (clamped - s.p) / dt : 0
  return { p: clamped, t: now, rate: Math.max(0, rate), retract: null }
}

export function displayed(s: DwellInterp, now: number): number {
  if (s.retract) {
    const k = Math.min(1, (now - s.retract.t) / RETRACT_MS)
    return s.retract.from + (s.p - s.retract.from) * k
  }
  const ahead = s.rate * Math.min(now - s.t, MAX_GAP_MS)
  return Math.min(1, s.p + Math.min(ahead, MAX_LEAD))
}
