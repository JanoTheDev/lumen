// Speech gate on the input level (RMS, 0..1) with an adaptive noise floor. Speech must clear
// both the user's threshold and the room's noise floor by `sensitivityDb`, so a fan or a
// busy room raises the bar instead of keeping a hands-free recording open until its limit.

export interface RmsGateOptions {
  /** Absolute level that always counts as quiet (the user's "speech threshold"). */
  threshold: number
  /** How far above the noise floor speech must be. */
  sensitivityDb?: number
  /**
   * Floor smoothing per update (tuned for ~80ms updates): fast while quiet, slow while loud so
   * steady noise is learned in seconds but a sentence is not.
   */
  quietAlpha?: number
  loudAlpha?: number
}

export class RmsGate {
  private floor: number
  private readonly ratio: number
  private readonly threshold: number
  private readonly quietAlpha: number
  private readonly loudAlpha: number

  constructor(opts: RmsGateOptions) {
    this.threshold = opts.threshold
    this.ratio = Math.pow(10, (opts.sensitivityDb ?? 12) / 20)
    this.quietAlpha = opts.quietAlpha ?? 0.1
    this.loudAlpha = opts.loudAlpha ?? 0.003
    // Start where the user's threshold sits, so the first frames behave as before.
    this.floor = opts.threshold / this.ratio
  }

  get noiseFloor(): number {
    return this.floor
  }

  /** Current level that counts as speech. */
  get bar(): number {
    return Math.max(this.threshold, this.floor * this.ratio)
  }

  /** Feeds one level reading; true when it counts as speech. */
  update(level: number): boolean {
    const speech = level > this.bar
    const a = speech ? this.loudAlpha : this.quietAlpha
    this.floor += (level - this.floor) * a
    return speech
  }
}
