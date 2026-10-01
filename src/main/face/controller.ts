// Face-gesture controller (11 T25): frames in, gesture actions out, plus the calibration
// samples. Electron-free; face/index.ts owns the window, IPC and the real actions.
import type { FaceCalibrateResult, FaceFrame, FaceState } from '@shared/channels'
import {
  FACE_GESTURES,
  type FaceAction,
  type FaceConfig,
  type FaceGesture,
  type FaceThreshold
} from '@shared/config'
import { GestureDetector, type DetectorOptions } from './detector'
import {
  boundGestures,
  GESTURE_KIND,
  GESTURE_LABEL,
  gestureScore,
  strength,
  thresholdsOf
} from './gestures'
import { calibrate, calibrationMessage } from './calibrate'
import { isRepeatable, SCROLL_REPEAT_MS } from './actions'

/** How long each calibration sample records. */
export const SAMPLE_MS = 2500
/** A frame older than this is not "the latest". */
const STALE_MS = 1000

export interface FaceControllerDeps {
  now(): number
  sleep(ms: number): Promise<void>
  config(): FaceConfig
  /** A gesture acted. */
  run(action: FaceAction, gesture: FaceGesture): void
  /** Stores a calibrated threshold. */
  saveThreshold(g: FaceGesture, t: FaceThreshold): void
}

export function detectorOptions(cfg: FaceConfig): DetectorOptions {
  const repeatMs: Partial<Record<FaceGesture, number>> = {}
  const active = boundGestures(cfg)
  for (const g of active) if (isRepeatable(cfg.bindings[g])) repeatMs[g] = SCROLL_REPEAT_MS
  return {
    holdMs: cfg.holdMs,
    cooldownMs: cfg.cooldownMs,
    thresholds: thresholdsOf(cfg),
    active,
    repeatMs
  }
}

export class FaceController {
  status: FaceState['status'] = 'off'
  error?: string
  private latest: { frame: FaceFrame; at: number } | null = null
  private last?: FaceState['last']
  private detector: GestureDetector
  private sampling: FaceFrame[] | null = null
  private rest: FaceFrame[] | null = null

  constructor(private deps: FaceControllerDeps) {
    this.detector = new GestureDetector(detectorOptions(deps.config()))
  }

  /** Bindings, thresholds or timings changed. */
  reconfigure(): void {
    this.detector.setOptions(detectorOptions(this.deps.config()))
  }

  setStatus(status: FaceState['status'], error?: string): void {
    this.status = status
    this.error = error
    if (status !== 'running') {
      this.latest = null
      this.detector.reset()
    }
  }

  onFrame(f: FaceFrame): void {
    const now = this.deps.now()
    this.latest = { frame: f, at: now }
    if (this.sampling) {
      if (f.face) this.sampling.push(f)
      return
    }
    const g = this.detector.step(f, now)
    if (!g) return
    const action = this.deps.config().bindings[g]
    if (action === 'none') return
    this.last = { gesture: g, action, at: now }
    this.deps.run(action, g)
  }

  state(installed: boolean, installing?: number): FaceState {
    const fresh = this.latest && this.deps.now() - this.latest.at < STALE_MS ? this.latest : null
    return {
      installed,
      ...(installing !== undefined ? { installing } : {}),
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      frame: fresh?.frame ?? null,
      levels: fresh ? this.levels(fresh.frame) : {},
      ...(this.last ? { last: this.last } : {}),
      calibrating: this.sampling !== null
    }
  }

  private levels(f: FaceFrame): Record<string, number> {
    if (!f.face) return {}
    const t = thresholdsOf(this.deps.config())
    const out: Record<string, number> = {}
    for (const g of FACE_GESTURES)
      out[g] = Math.round(Math.max(0, strength(g, f, t[g])) * 100) / 100
    return out
  }

  /** Records SAMPLE_MS of frames with a face; gestures do not act meanwhile. */
  private async sample(): Promise<FaceFrame[]> {
    const frames: FaceFrame[] = []
    this.sampling = frames
    try {
      await this.deps.sleep(SAMPLE_MS)
    } finally {
      this.sampling = null
      this.detector.reset()
    }
    return frames
  }

  async calibrateRest(): Promise<FaceCalibrateResult> {
    if (this.status !== 'running') return notRunning()
    if (this.sampling) return busy()
    const frames = await this.sample()
    if (frames.length < 10) {
      return { ok: false, message: calibrationMessage('few-samples'), samples: frames.length }
    }
    this.rest = frames
    return { ok: true, message: 'Got your resting face.', samples: frames.length }
  }

  async calibrateGesture(g: FaceGesture): Promise<FaceCalibrateResult> {
    if (this.status !== 'running') return notRunning()
    if (this.sampling) return busy()
    if (!this.rest) {
      return { ok: false, message: 'Record your resting face first.', samples: 0 }
    }
    const frames = await this.sample()
    const out = calibrate(
      this.rest.map((f) => gestureScore(g, f)),
      frames.map((f) => gestureScore(g, f)),
      GESTURE_KIND[g]
    )
    if (!out.ok)
      return { ok: false, message: calibrationMessage(out.reason), samples: frames.length }
    this.deps.saveThreshold(g, out.threshold)
    return { ok: true, message: `${GESTURE_LABEL[g]} is set.`, samples: frames.length }
  }
}

const notRunning = (): FaceCalibrateResult => ({
  ok: false,
  message: 'Turn on face gestures first. The camera has to be running.',
  samples: 0
})

const busy = (): FaceCalibrateResult => ({
  ok: false,
  message: 'Calibration is already recording.',
  samples: 0
})
