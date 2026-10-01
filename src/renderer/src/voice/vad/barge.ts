// Barge-in building blocks (pure): the sustained-speech detector and the pre-roll buffer.
import { RmsGate } from './rms'

export const BARGE_SUSTAIN_MS = 250
/** Short dips (between syllables) do not reset the sustain count. */
export const BARGE_GAP_MS = 80
/** Sustained speech over an adaptive gate. Pure; fed one level per block. */
export class BargeDetector {
  private readonly gate: RmsGate
  private speechMs = 0
  private quietMs = 0

  constructor(
    threshold: number,
    private readonly sustainMs = BARGE_SUSTAIN_MS,
    private readonly gapMs = BARGE_GAP_MS
  ) {
    this.gate = new RmsGate({ threshold })
  }

  /** True once speech has lasted `sustainMs` (then it starts counting again). */
  feed(level: number, blockMs: number): boolean {
    if (this.gate.update(level)) {
      this.speechMs += blockMs
      this.quietMs = 0
    } else if (this.speechMs > 0) {
      this.quietMs += blockMs
      if (this.quietMs > this.gapMs) this.speechMs = 0
    }
    if (this.speechMs < this.sustainMs) return false
    this.speechMs = 0
    return true
  }
}

/** Fixed-size ring of the most recent Int16 samples. */
export class PcmRing {
  private readonly buf: Int16Array
  private end = 0
  private filled = 0

  constructor(samples: number) {
    this.buf = new Int16Array(samples)
  }

  push(block: Int16Array): void {
    for (let i = 0; i < block.length; i++) {
      this.buf[this.end] = block[i]
      this.end = (this.end + 1) % this.buf.length
    }
    this.filled = Math.min(this.buf.length, this.filled + block.length)
  }

  /** The buffered audio, oldest first, as -1..1 floats. */
  take(): Float32Array {
    const out = new Float32Array(this.filled)
    const start = (this.end - this.filled + this.buf.length) % this.buf.length
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % this.buf.length] / 0x8000
    return out
  }
}

export function blockRms(block: Int16Array): number {
  if (!block.length) return 0
  let sum = 0
  for (let i = 0; i < block.length; i++) {
    const v = block[i] / 0x8000
    sum += v * v
  }
  return Math.sqrt(sum / block.length)
}

/** Joins Int16 blocks onto a float prefix. */
export function joinPcm(head: Float32Array, blocks: Int16Array[]): Float32Array {
  const total = blocks.reduce((n, b) => n + b.length, head.length)
  const out = new Float32Array(total)
  out.set(head)
  let at = head.length
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) out[at + i] = b[i] / 0x8000
    at += b.length
  }
  return out
}
