// Head pointer (11 T25 leftover): head yaw / pitch move the mouse pointer. Pure: time,
// cursor, screen bounds and the move itself come in through deps; face/index.ts wires them to
// Electron's screen and the agent's `input` move (input lane, user-direct).
//
// Relative mode is a joystick: the head's offset from centre, past a dead zone, sets the
// pointer's speed (curve ^ acceleration, top speed from `speed`). Absolute mode maps the
// calibrated head range onto the display the pointer is on. Angles are smoothed per frame
// (about 15 fps); moves go out at most MAX_HZ, one at a time.
import type { FaceFrame, FaceRangeAt } from '@shared/channels'
import type { FaceAxisRange, FacePointerConfig } from '@shared/config'
import type { Point, Rect } from '@shared/types'

export interface PointerRange {
  yaw: FaceAxisRange
  pitch: FaceAxisRange
}

/**
 * Before calibration. Positive yaw = the user's right (the renderer's convention), positive
 * pitch = looking down (assumed, not checked on a camera); calibration learns both.
 */
export const DEFAULT_RANGE: PointerRange = {
  yaw: { centre: 0, neg: -20, pos: 20 },
  pitch: { centre: 0, neg: -15, pos: 15 }
}

/** Moves sent per second at most. */
export const MAX_HZ = 30
/** The tick timer's period; a little over 1000 / MAX_HZ so no tick is skipped by the gate. */
export const TICK_MS = 34
/** Relative mode: px/s at the calibrated edge for speed 1. */
export const SPEED_UNIT = 200
/** Past the calibrated edge the offset keeps growing up to this (normalised units). */
export const MAX_NORM = 1.5
/** Absolute mode: smaller moves are jitter and are not sent (dwell needs a still pointer). */
export const ABS_MIN_STEP = 3
/** The real pointer this far from where we put it: someone else moved it, follow them. */
export const RESYNC_PX = 4
/** Frames with a face averaged for the automatic centre when nothing is calibrated. */
export const AUTO_CENTRE_FRAMES = 8
/** A tick after a longer gap counts as this long (a stalled timer must not jump). */
const MAX_DT_MS = 100

// ---- math ----

/** Removes `dz` around 0: inside → 0, outside → shifted toward 0 by dz. */
export function applyDeadZone(d: number, dz: number): number {
  const m = Math.abs(d) - Math.max(0, dz)
  return m > 0 ? Math.sign(d) * m : 0
}

/**
 * One head angle → its offset on one screen axis: 0 at the centre, ±1 at the calibrated
 * edge (neg = left / up, pos = right / down), up to ±MAX_NORM past it. The dead zone (in
 * degrees) is cut out first, so movement starts at 0 just outside it.
 */
export function normAxis(v: number, a: FaceAxisRange, dz = 0): number {
  const d = v - a.centre
  if (d === 0) return 0
  const posSpan = a.pos - a.centre
  const negSpan = a.neg - a.centre
  const towardPos = posSpan !== 0 && Math.sign(d) === Math.sign(posSpan)
  if (!towardPos && (negSpan === 0 || Math.sign(d) !== Math.sign(negSpan))) return 0
  const full = Math.abs(towardPos ? posSpan : negSpan)
  if (full <= dz) return 0
  const n = Math.max(0, Math.abs(d) - dz) / (full - dz)
  return (towardPos ? 1 : -1) * Math.min(n, MAX_NORM)
}

/** The dead zone's half size in normalised units (for the preview), from the narrower side. */
export function deadZoneNorm(a: FaceAxisRange, dz: number): number {
  const span = Math.min(Math.abs(a.pos - a.centre), Math.abs(a.neg - a.centre))
  return span > 0 ? Math.min(1, dz / span) : 0
}

/** Speed curve: sign kept, |n| ^ exponent (exponent 1 = linear). */
export function curve(n: number, exponent: number): number {
  return Math.sign(n) * Math.pow(Math.abs(n), Math.max(1, exponent))
}

/** Relative mode: px per second on one axis. */
export function axisSpeed(
  n: number,
  cfg: Pick<FacePointerConfig, 'speed' | 'acceleration'>
): number {
  return curve(n, cfg.acceleration) * cfg.speed * SPEED_UNIT
}

/** Absolute mode: -1..1 on each axis → a point in `b` (clamped to it). */
export function absoluteTarget(nx: number, ny: number, b: Rect): Point {
  const clamp = (n: number): number => Math.min(1, Math.max(-1, n))
  return {
    x: b.x + ((clamp(nx) + 1) / 2) * Math.max(0, b.w - 1),
    y: b.y + ((clamp(ny) + 1) / 2) * Math.max(0, b.h - 1)
  }
}

/** Shifts a range so its centre is at (yaw, pitch); spans stay. */
export function recentred(r: PointerRange, yaw: number, pitch: number): PointerRange {
  const shift = (a: FaceAxisRange, c: number): FaceAxisRange => {
    const d = c - a.centre
    return { centre: c, neg: a.neg + d, pos: a.pos + d }
  }
  return { yaw: shift(r.yaw, yaw), pitch: shift(r.pitch, pitch) }
}

/** Exponential smoothing: 0 = raw, 0.9 = each frame moves 10% of the way. */
export class Ema {
  value: number | null = null

  step(x: number, smoothing: number): number {
    const s = Math.min(0.95, Math.max(0, smoothing))
    this.value = this.value === null ? x : this.value + (1 - s) * (x - this.value)
    return this.value
  }

  reset(): void {
    this.value = null
  }
}

/** At most `hz` moves a second, and only one in flight. */
export class MoveGate {
  private last = -Infinity
  private busy = false
  readonly minMs: number

  constructor(hz: number) {
    this.minMs = Math.floor(1000 / hz)
  }

  take(now: number): boolean {
    if (this.busy || now - this.last < this.minMs) return false
    this.busy = true
    this.last = now
    return true
  }

  done(): void {
    this.busy = false
  }
}

// ---- range calibration ----

export const RANGE_STEPS: readonly FaceRangeAt[] = ['centre', 'left', 'right', 'up', 'down']
export const RANGE_MIN_SAMPLES = 10
/** Each side must be at least this many degrees from the centre. */
export const RANGE_MIN_SPAN = 5

export interface HeadSample {
  yaw: number
  pitch: number
}

export type RangeOutcome =
  | { ok: true; range: PointerRange }
  | { ok: false; reason: 'few-samples' | 'too-small' | 'same-side'; at?: FaceRangeAt }

const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Five samples (looking at the centre, left, right, top, bottom of the screen) → a range. */
export function rangeFromSamples(
  samples: Partial<Record<FaceRangeAt, readonly HeadSample[]>>
): RangeOutcome {
  for (const at of RANGE_STEPS) {
    if ((samples[at]?.length ?? 0) < RANGE_MIN_SAMPLES)
      return { ok: false, reason: 'few-samples', at }
  }
  const med = (at: FaceRangeAt, k: keyof HeadSample): number =>
    median(samples[at]!.map((s) => s[k]))
  const axis = (
    k: keyof HeadSample,
    negAt: FaceRangeAt,
    posAt: FaceRangeAt
  ): FaceAxisRange | RangeOutcome => {
    const centre = med('centre', k)
    const neg = med(negAt, k)
    const pos = med(posAt, k)
    if (Math.abs(neg - centre) < RANGE_MIN_SPAN)
      return { ok: false, reason: 'too-small', at: negAt }
    if (Math.abs(pos - centre) < RANGE_MIN_SPAN)
      return { ok: false, reason: 'too-small', at: posAt }
    if (Math.sign(neg - centre) === Math.sign(pos - centre))
      return { ok: false, reason: 'same-side', at: posAt }
    const r = (n: number): number => Math.round(n * 10) / 10
    return { centre: r(centre), neg: r(neg), pos: r(pos) }
  }
  const yaw = axis('yaw', 'left', 'right')
  if ('ok' in yaw) return yaw
  const pitch = axis('pitch', 'up', 'down')
  if ('ok' in pitch) return pitch
  return { ok: true, range: { yaw, pitch } }
}

export function rangeMessage(o: Extract<RangeOutcome, { ok: false }>): string {
  const where =
    o.at && o.at !== 'centre'
      ? ` to the ${o.at === 'up' ? 'top' : o.at === 'down' ? 'bottom' : o.at}`
      : ''
  switch (o.reason) {
    case 'few-samples':
      return 'I could not see your face long enough. Check the light and face the camera, then try again.'
    case 'too-small':
      return `Your head barely moved${where}. Turn a little further and hold it.`
    case 'same-side':
      return 'Both sides looked the same way. Start again from the centre.'
  }
}

// ---- the pointer ----

export interface HeadPointerDeps {
  config(): FacePointerConfig
  /** The real pointer now (logical px). */
  cursor(): Point
  /** Keeps a point on a display (the one nearest to it). */
  clamp(p: Point): Point
  /** Absolute mode's screen: the display the pointer is on. */
  bounds(): Rect
  /** Moves the pointer (logical px); resolves when done. */
  move(p: Point): Promise<void>
}

export interface PointerView {
  paused: boolean
  nx: number
  ny: number
  deadX: number
  deadY: number
}

export class HeadPointer {
  paused = false
  private yaw = new Ema()
  private pitch = new Ema()
  /** Runtime centre ("recentre", or automatic before calibration). */
  private centre: HeadSample | null = null
  private auto: HeadSample[] = []
  private pos: Point | null = null
  private lastSent: Point | null = null
  private lastTick: number | null = null
  private gate = new MoveGate(MAX_HZ)

  constructor(private deps: HeadPointerDeps) {}

  /** Forgets the runtime centre and motion (pointer turned on / off, range changed). */
  reset(): void {
    this.yaw.reset()
    this.pitch.reset()
    this.centre = null
    this.auto = []
    this.pos = null
    this.lastSent = null
    this.lastTick = null
  }

  onFrame(f: FaceFrame): void {
    if (!f.face) {
      // Lost face: stop, and smooth afresh when it comes back.
      this.yaw.reset()
      this.pitch.reset()
      this.lastTick = null
      return
    }
    const s = this.deps.config().smoothing
    this.yaw.step(f.yaw, s)
    this.pitch.step(f.pitch, s)
    if (!this.centre && !this.deps.config().range) {
      this.auto.push({ yaw: f.yaw, pitch: f.pitch })
      if (this.auto.length >= AUTO_CENTRE_FRAMES) {
        const avg = (k: keyof HeadSample): number =>
          this.auto.reduce((n, x) => n + x[k], 0) / this.auto.length
        this.centre = { yaw: avg('yaw'), pitch: avg('pitch') }
        this.auto = []
      }
    }
  }

  /** The head's current pose as the centre; false when no face is seen. */
  recentre(): boolean {
    if (this.yaw.value === null || this.pitch.value === null) return false
    this.centre = { yaw: this.yaw.value, pitch: this.pitch.value }
    this.pos = null
    return true
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.lastTick = null
  }

  range(): PointerRange | null {
    const base = this.deps.config().range ?? DEFAULT_RANGE
    if (this.centre) return recentred(base, this.centre.yaw, this.centre.pitch)
    return this.deps.config().range ? base : null
  }

  /** Head offset on both axes; null without a face or a centre yet. */
  offset(dz: number): { nx: number; ny: number } | null {
    const r = this.range()
    if (!r || this.yaw.value === null || this.pitch.value === null) return null
    return { nx: normAxis(this.yaw.value, r.yaw, dz), ny: normAxis(this.pitch.value, r.pitch, dz) }
  }

  view(): PointerView {
    const cfg = this.deps.config()
    const dz = cfg.mode === 'relative' ? cfg.deadZone : 0
    const o = this.offset(0)
    const r = this.range() ?? DEFAULT_RANGE
    return {
      paused: this.paused,
      nx: round2(o?.nx ?? 0),
      ny: round2(o?.ny ?? 0),
      deadX: round2(deadZoneNorm(r.yaw, dz)),
      deadY: round2(deadZoneNorm(r.pitch, dz))
    }
  }

  /** Called every TICK_MS while the pointer is on; sends at most one move. */
  tick(now: number): void {
    const prev = this.lastTick
    this.lastTick = now
    if (this.paused) return
    const cfg = this.deps.config()
    if (cfg.mode === 'absolute') return this.tickAbsolute(now)
    const o = this.offset(cfg.deadZone)
    if (!o || prev === null) return
    const dt = Math.min(MAX_DT_MS, Math.max(0, now - prev)) / 1000
    const vx = axisSpeed(o.nx, cfg)
    const vy = axisSpeed(o.ny, cfg)
    if (vx === 0 && vy === 0) {
      this.pos = null
      return
    }
    const real = this.deps.cursor()
    if (!this.pos || !this.lastSent || dist(real, this.lastSent) > RESYNC_PX) this.pos = { ...real }
    this.pos = this.deps.clamp({ x: this.pos.x + vx * dt, y: this.pos.y + vy * dt })
    const to = { x: Math.round(this.pos.x), y: Math.round(this.pos.y) }
    if (to.x === Math.round(real.x) && to.y === Math.round(real.y)) return
    this.send(to, now)
  }

  private tickAbsolute(now: number): void {
    const o = this.offset(0)
    if (!o) return
    const t = absoluteTarget(o.nx, o.ny, this.deps.bounds())
    const to = { x: Math.round(t.x), y: Math.round(t.y) }
    if (this.lastSent && dist(to, this.lastSent) < ABS_MIN_STEP) return
    this.send(to, now)
  }

  private send(to: Point, now: number): void {
    if (!this.gate.take(now)) return
    this.lastSent = to
    this.deps
      .move(to)
      .catch(() => {})
      .finally(() => this.gate.done())
  }
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const round2 = (n: number): number => Math.round(n * 100) / 100
