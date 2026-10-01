// Pointer ring buffer for deictic voice (11 T15): the agent's mouse-moved samples (physical px,
// ~60 Hz while moving, nothing at rest) for the last 10 seconds. "Where was the pointer when
// the user said 'this'" is the position held longest around that moment: the spoken time is
// an estimate, and people hold still on what they point at. No Electron.
import type { Point } from '@shared/types'

export interface PointerSample {
  t: number
  x: number
  y: number
}

/** 60 Hz for 10 s. */
export const RING_SIZE = 600
export const RING_MS = 10_000

export class PointerRing {
  private buf: PointerSample[] = []
  private head = 0

  constructor(private readonly size = RING_SIZE) {}

  push(s: PointerSample): void {
    if (this.buf.length < this.size) this.buf.push(s)
    else {
      this.buf[this.head] = s
      this.head = (this.head + 1) % this.size
    }
  }

  /** Samples oldest first. */
  samples(): PointerSample[] {
    return this.buf.length < this.size
      ? [...this.buf]
      : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)]
  }

  clear(): void {
    this.buf = []
    this.head = 0
  }

  /** The last known position at time `t` (the sample at or before it), else null. */
  at(t: number): Point | null {
    let hit: PointerSample | null = null
    for (const s of this.samples()) {
      if (s.t > t) break
      hit = s
    }
    return hit ? { x: hit.x, y: hit.y } : null
  }

  /**
   * The position held longest around `t`: each sample holds until the next one (the last
   * until `now`), weighted by a triangle of half-width `w` centred on `t`, so time close to the
   * spoken moment counts most. Before the first sample the pointer was at `before` (null =
   * unknown, that span is skipped).
   */
  heldNear(t: number, w: number, now: number, before: Point | null = null): Point | null {
    const list = this.samples().filter((s) => s.t <= now)
    // Integral of the triangle from t to x.
    const F = (x: number): number => {
      const d = Math.max(-w, Math.min(w, x - t))
      return Math.sign(d) * (Math.abs(d) - (d * d) / (2 * w))
    }
    let best: { p: Point; score: number } | null = null
    const consider = (p: Point, start: number, end: number): void => {
      const score = F(end) - F(start)
      if (score > 0 && (!best || score > best.score)) best = { p, score }
    }
    if (before && list.length) consider(before, t - w, list[0].t)
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      consider({ x: s.x, y: s.y }, s.t, i + 1 < list.length ? list[i + 1].t : now)
    }
    const found = best as { p: Point } | null
    return found ? found.p : list.length ? this.at(t) : before
  }
}
