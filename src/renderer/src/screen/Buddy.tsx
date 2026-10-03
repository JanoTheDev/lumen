// Cursor buddy (surfaces.md §1, motion.md §3). One rAF loop drives follow, flight, point
// nudge and the lesson "wait" bob, writing only `transform` and `opacity` on two absolutely
// positioned elements, so React never re-renders per frame. Geometry is in buddyPath.ts.
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import type { ScreenScene } from '@shared/events'
import type { Point, Rect } from '@shared/types'
import { useIpc } from '../lib/ipc'
import { SPRINGS, atRest, prefersReducedMotion, stepSpring, type SpringState } from '../ui/motion'
import {
  BUDDY_PX,
  FOLLOW_ANGLE,
  bezierHeading,
  chooseAnchor,
  easeInOut,
  entryPoint,
  flightFrame,
  followPoint,
  nudge,
  planFlight,
  type Anchor,
  type BuddySize,
  type Flight
} from './buddyPath'
import { distance, type Size } from './geometry'
import { pillSize, placeLabels } from './labels'

export interface BuddyConfig {
  enabled: boolean
  size: BuddySize
  color: string
  followCursor: boolean
}

export interface BuddyProps {
  buddy: ScreenScene['buddy']
  /** The highlight the buddy points at, when there is one. */
  targetRect?: Rect
  /** Other highlighted rects the buddy and its label must not cover. */
  avoid: Rect[]
  view: Size
  cfg: BuddyConfig
  fontPx: number
  /** A buddy working on screen (08 T53): its colour and a name tag beside the arrow. */
  worker?: ScreenScene['worker']
}

const FADE_MS = 120
const POINT_MS = 600
const WAIT_EVERY_MS = 8000
const BOB_MS = 400
const IDLE_HIDE_MS = 4000
/** A return to the cursor longer than this flies instead of springing. */
const FLY_BACK_PX = 160

type Phase = 'hidden' | 'follow' | 'flight' | 'parked'

function fade(el: HTMLElement | null, to: number, ms = FADE_MS): void {
  if (!el) return
  const from = getComputedStyle(el).opacity
  el.style.opacity = String(to)
  if (from !== String(to) && el.animate)
    el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'ease-out' })
}

/** Custom colours must be plain hex; anything else falls back to the accent. */
function fillOf(color: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--accent)'
}

class BuddyMotion {
  phase: Phase = 'hidden'
  pos: Point = { x: -100, y: -100 }
  angle = FOLLOW_ANGLE
  scale = 1
  visible = false
  private flight: Flight | null = null
  private flightStart = 0
  private spring: SpringState | null = null
  private followTo: Point = { x: 0, y: 0 }
  private arrivedAt = 0
  private mode: 'point' | 'wait' | 'idle' | 'fly' = 'idle'
  private raf = 0
  private wake: ReturnType<typeof setTimeout> | null = null
  private reduceTimer: ReturnType<typeof setTimeout> | null = null
  onArrive: () => void = () => {}

  constructor(
    private body: HTMLDivElement,
    private pulse: HTMLDivElement,
    private tag: HTMLDivElement | null = null
  ) {}

  dispose(): void {
    cancelAnimationFrame(this.raf)
    if (this.wake) clearTimeout(this.wake)
    if (this.reduceTimer) clearTimeout(this.reduceTimer)
  }

  show(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    fade(this.body, on ? 1 : 0)
    fade(this.tag, on ? 1 : 0)
  }

  /** Flies (or under reduced motion, fades) to the anchor. */
  goTo(anchor: Anchor, mode: 'point' | 'wait' | 'idle' | 'fly', start: Point | null): void {
    const same =
      (this.phase === 'parked' || this.phase === 'flight') &&
      this.mode !== 'fly' &&
      distance(this.flight?.to ?? this.pos, anchor.tip) < 0.5
    const changed = mode !== this.mode
    this.mode = mode
    if (same) {
      if (changed && this.phase === 'parked') {
        this.arrivedAt = performance.now()
        this.kick()
      }
      return
    }
    if (prefersReducedMotion()) {
      this.flight = null
      this.phase = 'parked'
      this.show(false)
      if (this.reduceTimer) clearTimeout(this.reduceTimer)
      this.reduceTimer = setTimeout(
        () => {
          this.pos = anchor.tip
          this.angle = anchor.angle
          this.scale = 1
          this.apply()
          this.show(true)
          this.arrivedAt = performance.now()
          this.onArrive()
        },
        this.visible ? FADE_MS : 0
      )
      return
    }
    let heading: Point | undefined
    if (this.phase === 'flight' && this.flight) {
      const t = Math.min(1, (performance.now() - this.flightStart) / this.flight.durationMs)
      heading = bezierHeading(this.flight, easeInOut(t))
      if (!heading.x && !heading.y) heading = undefined
    } else if (!this.visible || this.phase === 'hidden') {
      this.pos = start ?? entryPoint(anchor.tip, { w: innerWidth, h: innerHeight })
      this.angle = FOLLOW_ANGLE
    }
    this.flight = planFlight(this.pos, anchor.tip, this.angle, anchor.angle, heading)
    this.flightStart = performance.now()
    this.phase = 'flight'
    this.spring = null
    this.show(true)
    this.kick()
  }

  /** Follow mode: springs to the cursor offset; long returns fly. */
  follow(cursor: Point, view: Size): void {
    const f = followPoint(cursor, view)
    this.followTo = f.tip
    if (this.phase === 'hidden' || !this.visible) {
      this.mode = 'idle'
      this.pos = f.tip
      this.angle = f.angle
      this.phase = 'follow'
      this.spring = null
      this.apply()
      this.show(true)
      return
    }
    // Already flying back: the spring picks up the latest cursor when the flight lands.
    if (this.phase === 'flight' && this.mode === 'fly') return
    if (
      this.phase !== 'follow' &&
      distance(this.pos, f.tip) > FLY_BACK_PX &&
      !prefersReducedMotion()
    ) {
      this.mode = 'fly'
      this.flight = planFlight(this.pos, f.tip, this.angle, f.angle)
      this.flightStart = performance.now()
      this.phase = 'flight'
      this.kick()
      return
    }
    this.mode = 'idle'
    this.flight = null
    this.phase = 'follow'
    this.angle = f.angle
    if (prefersReducedMotion()) {
      this.pos = f.tip
      this.apply()
      return
    }
    if (!this.spring) this.spring = { x: [this.pos.x, this.pos.y], v: [0, 0] }
    this.kick()
  }

  hide(): void {
    // A pending reduced-motion reappear would bring the buddy back after hiding.
    if (this.reduceTimer) {
      clearTimeout(this.reduceTimer)
      this.reduceTimer = null
    }
    this.phase = 'hidden'
    this.flight = null
    this.spring = null
    this.show(false)
  }

  private kick(): void {
    if (this.wake) {
      clearTimeout(this.wake)
      this.wake = null
    }
    if (!this.raf) {
      let last = performance.now()
      const tick = (): void => {
        const now = performance.now()
        const dt = (now - last) / 1000
        last = now
        this.raf = 0
        if (this.frame(now, dt)) this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    }
  }

  /** One frame; returns true while something is still moving. */
  private frame(now: number, dt: number): boolean {
    let offset = 0
    let moving = false
    if (this.phase === 'flight' && this.flight) {
      const f = flightFrame(this.flight, now - this.flightStart)
      this.pos = f.pos
      this.angle = f.angle
      this.scale = f.scale
      if (f.done) {
        this.flight = null
        this.scale = 1
        if (this.mode === 'fly') {
          this.phase = 'follow'
          this.spring = { x: [this.pos.x, this.pos.y], v: [0, 0] }
          moving = true
        } else {
          this.phase = 'parked'
          this.arrivedAt = now
          this.onArrive()
          moving = true
        }
      } else moving = true
    } else if (this.phase === 'follow' && this.spring) {
      const to = [this.followTo.x, this.followTo.y]
      this.spring = stepSpring(this.spring, to, SPRINGS.follow, dt)
      if (atRest(this.spring, to)) {
        this.pos = { ...this.followTo }
        this.spring = null
      } else {
        this.pos = { x: this.spring.x[0], y: this.spring.x[1] }
        moving = true
      }
    } else if (this.phase === 'parked' && !prefersReducedMotion()) {
      const since = now - this.arrivedAt
      if (this.mode === 'point' && since < POINT_MS) {
        offset = nudge(since / POINT_MS, 2, 4)
        moving = true
      } else if (this.mode === 'wait') {
        const k = since % WAIT_EVERY_MS
        if (since >= WAIT_EVERY_MS && k < BOB_MS) {
          offset = nudge(k / BOB_MS, 1, 4)
          moving = true
        } else {
          this.wake = setTimeout(() => this.kick(), WAIT_EVERY_MS - k)
        }
      }
    }
    this.apply(offset)
    return moving
  }

  apply(offset = 0): void {
    const rad = (this.angle * Math.PI) / 180
    const x = this.pos.x + Math.cos(rad) * offset
    const y = this.pos.y + Math.sin(rad) * offset
    this.body.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${this.angle}deg) scale(${this.scale})`
    this.pulse.style.transform = `translate3d(${this.pos.x}px, ${this.pos.y}px, 0)`
    if (this.tag) this.tag.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }
}

const samePoint = (a: Point | null, b: Point | null): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y)

/**
 * The cursor arrives on `screen:cursor` up to ~60 times a second; it lives in a ref and drives
 * the motion directly, so the screen layer does not re-render per move.
 */
export const Buddy = memo(function Buddy(props: BuddyProps): JSX.Element {
  const { buddy, targetRect, avoid, view, cfg, fontPx, worker } = props
  const cursor = useRef<Point | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pulseRef = useRef<HTMLDivElement>(null)
  const tagRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const motion = useRef<BuddyMotion | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const px = BUDDY_PX[cfg.size] ?? BUDDY_PX.m
  const showArrow = cfg.enabled

  useLayoutEffect(() => {
    const m = new BuddyMotion(bodyRef.current!, pulseRef.current!, tagRef.current)
    motion.current = m
    return () => m.dispose()
  }, [])

  // Where to park, and the label beside it.
  const target = buddy ? (targetRect ?? { x: buddy.to.x - 1, y: buddy.to.y - 1, w: 2, h: 2 }) : null
  const anchor = target ? chooseAnchor(target, view, avoid, cfg.size) : null
  const label = buddy?.label
  const labelBox =
    anchor && label
      ? placeLabels(
          [
            {
              id: 'b',
              anchor: anchor.body,
              size: pillSize(label, Math.max(14, fontPx)),
              prefer: anchor.corner.startsWith('top') ? ['above', 'left', 'right'] : ['below']
            }
          ],
          target ? [target, ...avoid] : avoid,
          view
        ).get('b')
      : undefined

  const anchorKey = anchor ? `${anchor.tip.x},${anchor.tip.y},${anchor.angle}` : ''
  const mode = buddy?.mode ?? 'idle'

  useEffect(() => {
    const m = motion.current
    if (!m) return
    const label = labelRef.current
    if (!anchor) return
    label?.classList.remove('is-in')
    m.onArrive = () => {
      label?.classList.add('is-in')
      const p = pulseRef.current?.firstElementChild as HTMLElement | null
      if (showArrow && p?.animate && mode === 'point' && !prefersReducedMotion())
        p.animate(
          [
            { opacity: 0.4, scale: 1 },
            { opacity: 0, scale: 1.6 }
          ],
          { duration: 300, easing: 'ease-out' }
        )
    }
    m.goTo(anchor, mode, cursor.current)
    // Cursor moves must not restart the flight; the anchor key captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, mode])

  // Follow mode, idle hide and leaving this display.
  const syncFollow = (): void => {
    const m = motion.current
    const p = cursor.current
    if (!m || anchor) return
    labelRef.current?.classList.remove('is-in')
    if (!showArrow || !cfg.followCursor || !p) {
      m.hide()
      return
    }
    m.follow(p, view)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => motion.current?.hide(), IDLE_HIDE_MS)
  }
  useIpc('screen:cursor', (p) => {
    if (samePoint(p, cursor.current)) return
    cursor.current = p
    syncFollow()
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(syncFollow, [!!anchor, showArrow, cfg.followCursor, view.w, view.h])

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    },
    []
  )
  useEffect(() => {
    if (anchor && idleTimer.current) clearTimeout(idleTimer.current)
  })

  const len = px * 1.15
  const half = px / 2
  const box = Math.ceil(len + 8)
  // Tip at the origin pointing right; the body trails to the left with a soft notch.
  const d = `M 0 0 L ${-len} ${-half} Q ${-len * 0.72} 0 ${-len} ${half} Z`
  return (
    <>
      <div ref={pulseRef} className="sl-buddy-pulse" aria-hidden="true">
        <span style={{ width: px * 2, height: px * 2, left: -px, top: -px }} />
      </div>
      <div ref={bodyRef} className={`sl-buddy${showArrow ? '' : ' is-off'}`} aria-hidden="true">
        <svg
          width={box * 2}
          height={box * 2}
          viewBox={`${-box} ${-box} ${box * 2} ${box * 2}`}
          style={{ left: -box, top: -box }}
        >
          <path className="sl-buddy__halo" d={d} />
          <path
            className="sl-buddy__fill"
            d={d}
            style={{ fill: fillOf(worker?.color ?? cfg.color) }}
          />
        </svg>
      </div>
      <div
        ref={tagRef}
        className={`sl-buddy-tag${worker && showArrow ? '' : ' is-off'}`}
        aria-hidden="true"
      >
        <span className="sl-buddy-tag__pill">
          <span className="sl-buddy-tag__dot" style={{ background: fillOf(worker?.color ?? '') }} />
          {worker?.name}
        </span>
      </div>
      <div
        ref={labelRef}
        className="sl-pill sl-buddy-label"
        aria-hidden="true"
        style={
          labelBox
            ? { transform: `translate(${labelBox.x}px, ${labelBox.y}px)`, maxWidth: '22rem' }
            : { display: 'none' }
        }
      >
        <span>{label}</span>
      </div>
    </>
  )
})
