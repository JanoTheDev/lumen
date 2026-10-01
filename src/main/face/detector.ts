// Gesture detection (11 T25): turns a stream of frames into single gesture events. A gesture
// must stay over its threshold for holdMs (hold), then acts once and stays latched until it
// falls back under the release level (hysteresis), so one long mouth-open is one click.
// After any gesture acts, a new one waits cooldownMs. Repeatable gestures (scrolling) act
// again every repeatMs while held. A lost face resets everything. Pure: time comes in.
import type { FaceFrame } from '@shared/channels'
import type { FaceGesture, FaceThreshold } from '@shared/config'
import { project, releaseLevel, strength } from './gestures'

export interface DetectorOptions {
  holdMs: number
  cooldownMs: number
  thresholds: Record<FaceGesture, FaceThreshold>
  /** Gestures that may act (bound to an action). */
  active: readonly FaceGesture[]
  /** Gestures that act again while held, every this many ms. */
  repeatMs?: Partial<Record<FaceGesture, number>>
}

export class GestureDetector {
  /** Over the threshold since (ms). */
  private since = new Map<FaceGesture, number>()
  /** Acted and waiting to fall back under the release level. */
  private latched = new Map<FaceGesture, number>()
  private lastFire = -Infinity

  constructor(private opts: DetectorOptions) {}

  setOptions(opts: DetectorOptions): void {
    this.opts = opts
    this.reset()
  }

  reset(): void {
    this.since.clear()
    this.latched.clear()
  }

  /** Feeds one frame; returns the gesture that acts now, if any. */
  step(f: FaceFrame, now: number): FaceGesture | null {
    if (!f.face) {
      this.reset()
      return null
    }
    const { thresholds, holdMs, cooldownMs, active, repeatMs } = this.opts
    let best: { g: FaceGesture; s: number; repeat: boolean } | null = null
    const consider = (g: FaceGesture, s: number, repeat: boolean): void => {
      if (!best || s > best.s) best = { g, s, repeat }
    }
    for (const g of active) {
      const t = thresholds[g]
      const p = project(g, f, t)
      const firedAt = this.latched.get(g)
      if (firedAt !== undefined) {
        if (p < releaseLevel(t)) {
          this.latched.delete(g)
          this.since.delete(g)
        } else {
          const every = repeatMs?.[g]
          if (every && now - firedAt >= every) consider(g, strength(g, f, t), true)
        }
        continue
      }
      if (p >= t.on) {
        const start = this.since.get(g) ?? now
        this.since.set(g, start)
        if (now - start >= holdMs) consider(g, strength(g, f, t), false)
      } else {
        this.since.delete(g)
      }
    }
    const pick = best as { g: FaceGesture; s: number; repeat: boolean } | null
    if (!pick) return null
    if (!pick.repeat && now - this.lastFire < cooldownMs) return null
    this.latched.set(pick.g, now)
    this.lastFire = now
    return pick.g
  }
}
