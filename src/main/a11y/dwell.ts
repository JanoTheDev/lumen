// Dwell v2, main side (06 T08). The agent only tracks the cursor and says "a dwell finished
// here" (always configured as a left click). This controller decides what that dwell does:
//
//   over the palette     → plain left click on the palette button (works while paused)
//   in the pause corner  → toggle pause
//   paused by the user   → nothing
//   scroll arrows up     → scroll at the arrows' point, or close them
//   click type           → left / right / double click, drag start → drop, scroll arrows
//   risky target         → "dwell again to confirm" when safeTargets is on
//
// Snap to element moves the click to the nearest invokable control within 24 logical px.
// Automation holds the agent tracker (dwell_pause) so no dwell fires while Lumen acts.
// Pure: Electron, the agent and windows come in through DwellIo.
import type { DwellPaletteButton, DwellPaletteState, DwellRingData } from '@shared/channels'
import type { ElementNode, InputStep, Point, Rect } from '@shared/types'

export type DwellClick = Exclude<DwellPaletteButton, 'pause'>

export interface DwellSettings {
  enabled: boolean
  ms: number
  cooldownMs: number
  clickType: 'left' | 'right' | 'double' | 'drag'
  sticky: boolean
  maxRepeats: number
  radiusPx: number
  snapToElement: boolean
  safeTargets: boolean
  ringSize: 's' | 'm' | 'l' | 'xl'
  pauseCorner: 'none' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** Cursor smoothing (EMA alpha 0-0.9) the agent applies before the radius test; 0 = off. */
  smoothing?: number
}

/** What `dwell_config` gets (C2). The agent always does left; main decides the click type. */
export interface AgentDwellConfig {
  enabled: boolean
  ms: number
  cooldownMs: number
  clickType: 'left'
  maxRepeats: number
  /** Physical px (the agent's tracker works in physical px). */
  moveTolerancePx: number
  /** Also on for safeTargets: the trigger then carries the element's name. */
  snapToElement: boolean
  smoothing: number
}

export interface DwellConfigSource {
  dwellClick: { enabled: boolean; dwellMs: number; cooldownMs: number }
  a11y: { dwell: Omit<DwellSettings, 'enabled' | 'ms' | 'cooldownMs'> }
}

export function dwellSettings(cfg: DwellConfigSource): DwellSettings {
  const d = cfg.a11y.dwell
  return {
    enabled: cfg.dwellClick.enabled,
    ms: cfg.dwellClick.dwellMs,
    cooldownMs: cfg.dwellClick.cooldownMs,
    clickType: d.clickType,
    sticky: d.sticky,
    maxRepeats: d.maxRepeats,
    radiusPx: d.radiusPx,
    snapToElement: d.snapToElement,
    safeTargets: d.safeTargets,
    ringSize: d.ringSize,
    pauseCorner: d.pauseCorner,
    smoothing: d.smoothing
  }
}

export function agentDwellConfig(s: DwellSettings, scale: number): AgentDwellConfig {
  return {
    enabled: s.enabled,
    ms: s.ms,
    cooldownMs: s.cooldownMs,
    clickType: 'left',
    maxRepeats: s.maxRepeats,
    moveTolerancePx: Math.round(s.radiusPx * Math.max(1, scale)),
    snapToElement: s.snapToElement || s.safeTargets,
    smoothing: Math.min(0.9, Math.max(0, s.smoothing ?? 0))
  }
}

export const RING_PX: Record<DwellSettings['ringSize'], number> = { s: 32, m: 48, l: 64, xl: 96 }
/** Snap reach, logical px. */
export const SNAP_PX = 24
/** Reach of a lesson's snap target (07 T21), logical px around its rect. */
export const HINT_SNAP_PX = 48
/** Pause corner hot zone, logical px from the corner. */
export const CORNER_PX = 40
/** Scroll arrows: distance from the dwell point and hit box, logical px. */
export const SCROLL_REACH_PX = 72
export const SCROLL_BOX_PX = 56
export const SCROLL_NOTCHES = 5
/** A risky target's second dwell must come within this. */
export const CONFIRM_MS = 8000

const RISKY =
  /\b(delete|remove|send|buy|pay|purchase|submit|checkout|check out|place order|order now|discard|don'?t save|close without saving|uninstall|erase|format|empty (the )?(trash|recycle bin)|sign out|log out|transfer)\b/i

/** True for control names a stray dwell should not hit without a second look. */
export function isRiskyName(name: string | undefined): boolean {
  return !!name && RISKY.test(name)
}

const SNAP_ROLES = new Set([
  'button',
  'checkbox',
  'radiobutton',
  'hyperlink',
  'menuitem',
  'tabitem',
  'listitem',
  'treeitem',
  'combobox',
  'splitbutton',
  'edit'
])

function snappable(n: ElementNode): boolean {
  if (!n.enabled || n.rect.w <= 0 || n.rect.h <= 0) return false
  return (
    SNAP_ROLES.has(n.role) ||
    n.patterns.some((p) => p === 'invoke' || p === 'toggle' || p === 'select')
  )
}

function distToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h))
  return Math.hypot(dx, dy)
}

export const centerOf = (r: Rect): Point => ({
  x: Math.round(r.x + r.w / 2),
  y: Math.round(r.y + r.h / 2)
})

const inside = (a: Rect, b: Rect): boolean =>
  a !== b && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

/**
 * Nearest invokable control within `reachPhys` of `p` (all physical px). A container that
 * holds another candidate (a list row around its checkbox) gives way to what it contains.
 */
export function snapTarget(p: Point, nodes: ElementNode[], reachPhys: number): ElementNode | null {
  const near = nodes.filter((n) => snappable(n) && distToRect(p, n.rect) <= reachPhys)
  const leaves = near.filter((n) => !near.some((m) => inside(m.rect, n.rect)))
  let best: ElementNode | null = null
  let bestD = Infinity
  let bestArea = Infinity
  for (const n of leaves) {
    const d = distToRect(p, n.rect)
    const area = n.rect.w * n.rect.h
    if (d < bestD || (d === bestD && area < bestArea)) {
      best = n
      bestD = d
      bestArea = area
    }
  }
  return best
}

export type Corner = DwellSettings['pauseCorner']

/** True when `p` is in the hot corner of `display` (logical px). */
export function inCorner(p: Point, display: Rect, corner: Corner, px = CORNER_PX): boolean {
  if (corner === 'none') return false
  const left = p.x - display.x < px
  const right = display.x + display.w - p.x <= px
  const top = p.y - display.y < px
  const bottom = display.y + display.h - p.y <= px
  switch (corner) {
    case 'top-left':
      return left && top
    case 'top-right':
      return right && top
    case 'bottom-left':
      return left && bottom
    case 'bottom-right':
      return right && bottom
  }
}

export type ScrollDir = 'up' | 'down' | 'left' | 'right'
const ARROW: Record<ScrollDir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
}

/** Which scroll arrow around `at` (logical) the point hits, if any. */
export function scrollArrowAt(at: Point, p: Point): ScrollDir | null {
  for (const dir of Object.keys(ARROW) as ScrollDir[]) {
    const c = { x: at.x + ARROW[dir].x * SCROLL_REACH_PX, y: at.y + ARROW[dir].y * SCROLL_REACH_PX }
    if (Math.abs(p.x - c.x) <= SCROLL_BOX_PX / 2 && Math.abs(p.y - c.y) <= SCROLL_BOX_PX / 2)
      return dir
  }
  return null
}

/** Agent dwell event (dwell-progress / dwell-trigger). x/y are physical px. */
export interface DwellEvent {
  x: number
  y: number
  progress?: number
  active?: boolean
  /** Control under the cursor (snapToElement), physical rect. */
  element?: { rect?: Rect; role?: string; name?: string }
}

function parseDwellEvent(raw: unknown): DwellEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return null
  const ev: DwellEvent = { x: r.x, y: r.y }
  if (typeof r.progress === 'number') ev.progress = r.progress
  if (typeof r.active === 'boolean') ev.active = r.active
  const el = r.element as Record<string, unknown> | undefined
  if (el && typeof el === 'object') {
    const rect = el.rect as Rect | undefined
    ev.element = {
      rect:
        rect && [rect.x, rect.y, rect.w, rect.h].every((v) => typeof v === 'number')
          ? rect
          : undefined,
      role: typeof el.role === 'string' ? el.role : undefined,
      name: typeof el.name === 'string' ? el.name : undefined
    }
  }
  return ev
}

/** The a11y overlay the screen layer draws for dwell (global logical px). */
export interface DwellOverlay {
  scrollAt?: Point
  dragFrom?: Point
}

export interface DwellIo {
  now(): number
  settings(): DwellSettings
  /** Agent input steps, physical px. */
  input(steps: InputStep[]): Promise<void>
  physToLogical(p: Point): Point
  logicalToPhys(p: Point): Point
  physRectToLogical(r: Rect): Rect
  /** Display (logical bounds) and scale factor at a logical point. */
  displayAt(p: Point): { bounds: Rect; scale: number }
  /** The palette window is under this logical point. */
  overPalette(p: Point): boolean
  /** Latest interactive UIA nodes of the foreground window (physical px). */
  nodes(): ElementNode[]
  /** Pause / resume the agent's tracker (automation). */
  holdAgent(paused: boolean): void
  ring(data: DwellRingData): void
  overlay(o: DwellOverlay): void
  paletteState(s: DwellPaletteState): void
  announce(text: string): void
  log(msg: string): void
}

export class DwellController {
  /** Palette pick for the next dwell; null = the configured default. */
  private pick: DwellClick | null = null
  private userPaused = false
  private holds = new Map<string, number>()
  private dragFrom: { phys: Point; logical: Point } | null = null
  private scroll: { phys: Point; logical: Point } | null = null
  private confirm: { key: string; until: number } | null = null
  /** The running lesson step's target (logical px): dwells near it land on it. */
  private snapHint: Rect | null = null

  constructor(private readonly io: DwellIo) {}

  /** Lesson target to snap dwells to (07 T21); null clears it. */
  setSnapHint(rect: Rect | null): void {
    this.snapHint = rect && rect.w > 0 && rect.h > 0 ? rect : null
  }

  /** The lesson target when the dwell point (logical) is within reach of it. */
  private hintAt(at: Point): Rect | null {
    const r = this.snapHint
    return r && distToRect(at, r) <= HINT_SNAP_PX ? r : null
  }

  get paused(): boolean {
    return this.userPaused
  }

  /** What the next dwell does. */
  next(): DwellClick {
    return this.pick ?? this.io.settings().clickType
  }

  state(): DwellPaletteState {
    const s = this.io.settings()
    return {
      enabled: s.enabled,
      next: this.next(),
      sticky: s.sticky,
      paused: this.userPaused,
      dragging: !!this.dragFrom,
      scrolling: !!this.scroll
    }
  }

  /** Palette button or voice. */
  choose(button: DwellPaletteButton): void {
    if (button === 'pause') {
      this.setPaused(!this.userPaused)
      return
    }
    this.clearModes()
    this.pick = button
    this.io.announce(`Next dwell: ${LABEL[button]}`)
    this.publish()
  }

  /** User pause (voice, palette, corner). The tracker keeps running for the corner/palette. */
  setPaused(on: boolean): boolean {
    if (!this.io.settings().enabled) return false
    if (on === this.userPaused) return true
    this.userPaused = on
    if (on) this.clearModes()
    this.io.announce(on ? 'Dwell paused' : 'Dwell on')
    this.publish()
    return true
  }

  /** Holds the agent tracker while Lumen acts; returns the release. Re-entrant per reason. */
  hold(reason: string): () => void {
    const total = (): number => [...this.holds.values()].reduce((a, b) => a + b, 0)
    if (total() === 0) this.io.holdAgent(true)
    this.holds.set(reason, (this.holds.get(reason) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.holds.get(reason) ?? 1) - 1
      if (n <= 0) this.holds.delete(reason)
      else this.holds.set(reason, n)
      if (total() === 0) this.io.holdAgent(false)
    }
  }

  get held(): boolean {
    return this.holds.size > 0
  }

  /** Escape / cancel: drop a half-done drag, the scroll arrows and the pick. */
  reset(): void {
    const had = this.dragFrom || this.scroll || this.pick
    this.clearModes()
    this.pick = null
    this.confirm = null
    if (had) this.publish()
  }

  onProgress(raw: unknown): void {
    const ev = parseDwellEvent(raw)
    if (!ev) return
    const s = this.io.settings()
    if (!s.enabled) return
    const at = this.io.physToLogical({ x: ev.x, y: ev.y })
    const palette = this.io.overPalette(at)
    const corner = inCorner(at, this.io.displayAt(at).bounds, s.pauseCorner)
    const ring: DwellRingData = {
      x: Math.round(at.x),
      y: Math.round(at.y),
      progress: ev.progress ?? 0,
      active: !!ev.active,
      size: RING_PX[s.ringSize],
      clickType: palette ? 'left' : corner ? 'pause' : this.ringType()
    }
    if (this.userPaused) {
      // Paused: only the palette and the corner can be dwelled on (to resume).
      if (!palette && !corner) ring.active = false
      ring.paused = true
    } else if (!palette && !corner && !this.scroll && this.hintAt(at)) {
      ring.target = this.hintAt(at)!
    } else if (!palette && !corner && !this.scroll && s.snapToElement) {
      const target = this.snap({ x: ev.x, y: ev.y }, at)
      if (target) {
        ring.target = this.io.physRectToLogical(target.rect)
        ring.warn = s.safeTargets && isRiskyName(target.name)
      }
    }
    this.io.ring(ring)
  }

  async onTrigger(raw: unknown): Promise<void> {
    const ev = parseDwellEvent(raw)
    if (!ev) return
    const s = this.io.settings()
    if (!s.enabled) return
    const phys = { x: ev.x, y: ev.y }
    const at = this.io.physToLogical(phys)

    // Own UI first: the palette is always a plain click, also while paused.
    if (this.io.overPalette(at)) {
      await this.click(phys, 'left')
      return
    }
    if (inCorner(at, this.io.displayAt(at).bounds, s.pauseCorner)) {
      this.setPaused(!this.userPaused)
      return
    }
    if (this.userPaused || this.held) return

    if (this.scroll) return this.scrollAt(at)

    const type = this.next()
    if (type === 'scroll') {
      this.scroll = { phys, logical: at }
      this.io.overlay({ scrollAt: at })
      this.io.announce('Dwell on an arrow to scroll, anywhere else to stop')
      this.publish()
      return
    }

    const hint = this.hintAt(at)
    const node = !hint && s.snapToElement ? this.snap(phys, at) : null
    const point = hint ? this.io.logicalToPhys(centerOf(hint)) : node ? centerOf(node.rect) : phys
    const name = node?.name ?? ev.element?.name
    const rect = node?.rect ?? ev.element?.rect
    if (
      s.safeTargets &&
      isRiskyName(name) &&
      !this.confirmed(name!, rect ? centerOf(rect) : point)
    ) {
      this.io.announce(`${name}: dwell on it again to confirm`)
      return
    }

    if (type === 'drag') {
      if (!this.dragFrom) {
        this.dragFrom = { phys: point, logical: this.io.physToLogical(point) }
        this.io.overlay({ dragFrom: this.dragFrom.logical })
        this.io.announce('Drag start set. Dwell where to drop')
        this.publish()
        return
      }
      const from = this.dragFrom.phys
      this.dragFrom = null
      this.io.overlay({})
      await this.io.input([{ t: 'drag', from, to: point }])
      this.done()
      return
    }
    await this.click(point, type)
    this.done()
  }

  // ---- internals ----

  private ringType(): string {
    if (this.scroll) return 'scroll'
    if (this.dragFrom) return 'drop'
    return this.next()
  }

  private snap(phys: Point, at: Point): ElementNode | null {
    const scale = this.io.displayAt(at).scale
    return snapTarget(phys, this.io.nodes(), SNAP_PX * scale)
  }

  /** Second dwell on the same risky target within CONFIRM_MS goes through. */
  private confirmed(name: string, point: Point): boolean {
    const key = `${name}|${Math.round(point.x / 8)}|${Math.round(point.y / 8)}`
    const now = this.io.now()
    if (this.confirm && this.confirm.key === key && now <= this.confirm.until) {
      this.confirm = null
      return true
    }
    this.confirm = { key, until: now + CONFIRM_MS }
    return false
  }

  private async click(p: Point, type: 'left' | 'right' | 'double'): Promise<void> {
    await this.io.input([
      {
        t: 'click',
        button: type === 'right' ? 'right' : 'left',
        count: type === 'double' ? 2 : 1,
        x: p.x,
        y: p.y
      }
    ])
  }

  private async scrollAt(p: Point): Promise<void> {
    const sc = this.scroll!
    const dir = scrollArrowAt(sc.logical, p)
    if (!dir) {
      this.scroll = null
      this.io.overlay({})
      this.io.announce('Scrolling done')
      this.done()
      return
    }
    const d = ARROW[dir]
    await this.io.input([
      {
        t: 'scroll',
        dx: d.x * SCROLL_NOTCHES,
        dy: d.y * SCROLL_NOTCHES,
        x: sc.phys.x,
        y: sc.phys.y
      }
    ])
  }

  /** A dwell action finished: a one-off pick goes back to the default. */
  private done(): void {
    if (!this.io.settings().sticky) this.pick = null
    this.publish()
  }

  private clearModes(): void {
    if (this.dragFrom || this.scroll) this.io.overlay({})
    this.dragFrom = null
    this.scroll = null
  }

  private publish(): void {
    this.io.paletteState(this.state())
  }
}

const LABEL: Record<DwellClick, string> = {
  left: 'left click',
  right: 'right click',
  double: 'double click',
  drag: 'drag',
  scroll: 'scroll'
}

// ---- process-wide instance (executor holds it during automation) ----

let active: DwellController | null = null

export function setDwellController(c: DwellController | null): void {
  active = c
}

export function dwellController(): DwellController | null {
  return active
}

/** Pauses the agent's dwell tracker until the returned release runs (no-op without dwell). */
export function holdDwell(reason: string): () => void {
  return active ? active.hold(reason) : () => {}
}
