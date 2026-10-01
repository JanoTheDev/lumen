// Cursor buddy geometry (surfaces.md §1.2, motion.md §3): where it parks beside a target,
// the curved flight there, and the follow offset. Pure, so it can be unit tested.
//
// Angles are in degrees, 0 = the tip points right (+x), positive is clockwise (screen y down).
import type { Point, Rect } from '@shared/types'
import { distance, inside, overlaps, type Size } from './geometry'

export const BUDDY_PX = { s: 10, m: 14, l: 20, xl: 28 } as const
export type BuddySize = keyof typeof BUDDY_PX

/** The real cursor points up-left; the follow buddy matches it. */
export const FOLLOW_ANGLE = -135

const PARK_GAP = 6
const FOLLOW_OFFSET = 18
const EDGE = 40

export type Corner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
const CORNERS: Corner[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right']

export interface Anchor {
  /** Where the tip sits. */
  tip: Point
  /** Rest rotation: the tip points at the target's corner. */
  angle: number
  corner: Corner
  /** The box the buddy body covers, for offscreen / overlap checks. */
  body: Rect
}

/** Body box for a tip at `tip` with the body trailing away from the target. */
function bodyBox(tip: Point, corner: Corner, px: number): Rect {
  const s = Math.ceil(px * 1.4) + 4
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  return { x: left ? tip.x - s : tip.x, y: top ? tip.y - s : tip.y, w: s, h: s }
}

function anchorAt(target: Rect, corner: Corner, px: number): Anchor {
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  const tip = {
    x: left ? target.x - PARK_GAP : target.x + target.w + PARK_GAP,
    y: top ? target.y - PARK_GAP : target.y + target.h + PARK_GAP
  }
  const angle = top ? (left ? 45 : 135) : left ? -45 : -135
  return { tip, angle, corner, body: bodyBox(tip, corner, px) }
}

/**
 * Parks beside the target, never on it: bottom-left first, then bottom-right, top-left and
 * top-right. A corner is skipped when the body would be offscreen or cover another
 * highlighted rect. If none fits, the first on-screen corner wins, then bottom-left.
 */
export function chooseAnchor(
  target: Rect,
  view: Size,
  avoid: readonly Rect[] = [],
  size: BuddySize = 'm'
): Anchor {
  const px = BUDDY_PX[size]
  const all = CORNERS.map((c) => anchorAt(target, c, px))
  const onScreen = all.filter((a) => inside(a.body, view))
  const clear = onScreen.find((a) => !avoid.some((r) => overlaps(a.body, r)))
  if (clear) return clear
  if (onScreen.length) return onScreen[0]
  // The target fills the display: park just inside its bottom-left corner, on screen.
  const s = bodyBox({ x: 0, y: 0 }, 'bottom-left', px).w
  const clampTo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))
  const tip = {
    x: clampTo(target.x + PARK_GAP + s, s, view.w),
    y: clampTo(target.y + target.h - PARK_GAP - s, 0, view.h - s)
  }
  return { tip, angle: -45, corner: 'bottom-left', body: bodyBox(tip, 'bottom-left', px) }
}

/** Follow position: cursor + 18,18, flipped toward the centre within 40px of an edge. */
export function followPoint(cursor: Point, view: Size): { tip: Point; angle: number } {
  const flipX = cursor.x + FOLLOW_OFFSET + EDGE > view.w
  const flipY = cursor.y + FOLLOW_OFFSET + EDGE > view.h
  const tip = {
    x: cursor.x + (flipX ? -FOLLOW_OFFSET : FOLLOW_OFFSET),
    y: cursor.y + (flipY ? -FOLLOW_OFFSET : FOLLOW_OFFSET)
  }
  // Keep pointing back at the cursor.
  const angle = flipY ? (flipX ? 45 : 135) : flipX ? -45 : FOLLOW_ANGLE
  return { tip, angle }
}

// ---- Flight ----

export const FLIGHT_MIN_MS = 300
export const FLIGHT_MAX_MS = 600
const MAX_TILT = 25
const SCALE_PEAK = 0.08

export function flightDuration(dist: number): number {
  return Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, 180 + dist * 0.35))
}

export interface Flight {
  from: Point
  ctrl: Point
  to: Point
  fromAngle: number
  toAngle: number
  durationMs: number
}

/**
 * Control point: the midpoint pushed perpendicular by min(20% of the distance, 120px),
 * toward the upper side so the arc rises. `heading` (a unit vector) continues a flight in
 * progress so a retarget keeps its direction instead of kinking.
 */
export function controlPoint(from: Point, to: Point, heading?: Point): Point {
  const d = distance(from, to)
  if (heading && d > 0) {
    const reach = Math.min(d * 0.35, 160)
    return { x: from.x + heading.x * reach, y: from.y + heading.y * reach }
  }
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  if (d < 1) return mid
  let nx = -(to.y - from.y) / d
  let ny = (to.x - from.x) / d
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx = -nx
    ny = -ny
  }
  const off = Math.min(0.2 * d, 120)
  return { x: mid.x + nx * off, y: mid.y + ny * off }
}

export function planFlight(
  from: Point,
  to: Point,
  fromAngle: number,
  toAngle: number,
  heading?: Point
): Flight {
  const d = distance(from, to)
  return {
    from,
    ctrl: controlPoint(from, to, heading),
    to,
    fromAngle,
    toAngle,
    durationMs: flightDuration(d)
  }
}

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export function bezierAt(f: Pick<Flight, 'from' | 'ctrl' | 'to'>, u: number): Point {
  const a = (1 - u) * (1 - u)
  const b = 2 * (1 - u) * u
  const c = u * u
  return {
    x: a * f.from.x + b * f.ctrl.x + c * f.to.x,
    y: a * f.from.y + b * f.ctrl.y + c * f.to.y
  }
}

/** Unit tangent of the curve at `u`. */
export function bezierHeading(f: Pick<Flight, 'from' | 'ctrl' | 'to'>, u: number): Point {
  const dx = 2 * (1 - u) * (f.ctrl.x - f.from.x) + 2 * u * (f.to.x - f.ctrl.x)
  const dy = 2 * (1 - u) * (f.ctrl.y - f.from.y) + 2 * u * (f.to.y - f.ctrl.y)
  const len = Math.hypot(dx, dy)
  return len < 1e-6 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len }
}

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (((b - a) % 360) + 360) % 360
  if (d > 180) d -= 360
  return d
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface FlightFrame {
  pos: Point
  angle: number
  scale: number
  done: boolean
}

/**
 * The buddy at `elapsedMs` into a flight. It leans into the path tangent (at most 25° off
 * its rest angle), settles to the arrival angle over the last 40%, and swells 1 → 1.08 → 1.
 */
export function flightFrame(f: Flight, elapsedMs: number): FlightFrame {
  const t = Math.min(1, Math.max(0, elapsedMs / f.durationMs))
  const u = easeInOut(t)
  const pos = bezierAt(f, u)
  const h = bezierHeading(f, u)
  const rest = f.fromAngle + angleDelta(f.fromAngle, f.toAngle) * smoothstep(0, 1, t)
  let angle = rest
  if (h.x || h.y) {
    const tangent = (Math.atan2(h.y, h.x) * 180) / Math.PI
    const lean = Math.max(-MAX_TILT, Math.min(MAX_TILT, angleDelta(rest, tangent)))
    angle = rest + lean * (1 - smoothstep(0.6, 1, t)) * smoothstep(0, 0.15, t)
  }
  const scale = 1 + SCALE_PEAK * Math.sin(Math.PI * t)
  return { pos: t >= 1 ? f.to : pos, angle: t >= 1 ? f.toAngle : angle, scale, done: t >= 1 }
}

/** Nudge toward the target: `cycles` bumps of `amp` px over the whole progress 0..1. */
export function nudge(progress: number, cycles: number, amp: number): number {
  if (progress <= 0 || progress >= 1) return 0
  return amp * Math.pow(Math.sin(Math.PI * cycles * progress), 2)
}

/** Where a buddy arriving from another display enters: the nearest edge of this one. */
export function entryPoint(to: Point, view: Size): Point {
  const d = [to.x, view.w - to.x, to.y, view.h - to.y]
  const i = d.indexOf(Math.min(...d))
  if (i === 0) return { x: -20, y: to.y }
  if (i === 1) return { x: view.w + 20, y: to.y }
  if (i === 2) return { x: to.x, y: -20 }
  return { x: to.x, y: view.h + 20 }
}
