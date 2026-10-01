// Switch access scanning (06 T09): a highlight moves through a tree of choices and a switch
// picks one. 1-switch auto-scan moves on a timer; 2-switch step-scan moves on switch A and
// picks on switch B. Pure state machine: timers, rendering and the tree come from ScannerIo.
import type { ScanScene } from '@shared/events'
import type { Point, Rect } from '@shared/types'

export type ScanResult =
  /** Open a sub-level (Back returns here). */
  | { push: ScanLevel }
  /** Swap the current level (grid zoom); its onExit does not run. */
  | { replace: ScanLevel }
  | 'back'
  /** Done: start over at the top. */
  | 'root'
  /** Keep scanning this level from where it is. */
  | 'stay'
  /** Stop and wait for a switch press to start again. */
  | 'idle'

export interface ScanItem {
  label: string
  /** Global logical px: the scan ring goes around it. */
  rect?: Rect
  /** Number drawn on the ring (marks, grid cells). */
  n?: number
  select(): ScanResult | Promise<ScanResult>
}

export interface ScanLevel {
  title: string
  items: ScanItem[]
  /** Where the menu panel goes (global logical px); default near the cursor. */
  anchor?: Point
  /** The level draws itself (scan keyboard): no ring, no menu panel. */
  external?: boolean
  /** The highlighted item (null when the level is left or covered). */
  onHighlight?(index: number | null): void
  /** The level was left by Back, root or stop. */
  onExit?(): void
}

export interface ScanSettings {
  mode: 'auto' | 'step'
  intervalMs: number
  /** Auto-scan passes over a level before it backs out (at the top: goes idle). */
  loops: number
}

/** What the screen layer draws for the current highlight. */
export interface ScanView {
  title: string
  items: { label: string; rect?: Rect; n?: number }[]
  index: number
  anchor?: Point
  external: boolean
}

export interface ScannerIo {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
  settings(): ScanSettings
  /** The top level, rebuilt each time scanning returns to it. */
  root(): ScanLevel
  render(view: ScanView | null): void
  announce(text: string): void
  log(msg: string): void
}

export type ScanState = 'off' | 'idle' | 'scanning' | 'busy'
export type SwitchRole = 'select' | 'next'

/** Presses closer together than this are one press (switch bounce, tremor). */
export const DEBOUNCE_MS = 250
/** The first item of a fresh level stays a little longer so the user can react. */
export const FIRST_ITEM_FACTOR = 1.5

const BACK_LABEL = 'Back'
const PAUSE_LABEL = 'Pause scanning'

interface Frame {
  level: ScanLevel
  items: ScanItem[]
}

export class Scanner {
  private stack: Frame[] = []
  private index = 0
  private passes = 0
  private timer: unknown = null
  private lastPress = -Infinity
  private _state: ScanState = 'off'

  constructor(private readonly io: ScannerIo) {}

  get state(): ScanState {
    return this._state
  }

  /** Path of level titles, top first (tests, logs). */
  path(): string[] {
    return this.stack.map((f) => f.level.title)
  }

  current(): ScanItem | undefined {
    return this.top()?.items[this.index]
  }

  /** Starts at the top level. */
  start(): void {
    this.exitAll()
    this._state = 'scanning'
    this.enter(this.io.root(), true)
  }

  /** Scanning off: nothing is drawn and switch presses are ignored. */
  stop(): void {
    this.exitAll()
    this.clearTimer()
    this._state = 'off'
    this.io.render(null)
  }

  /** Paused: nothing is drawn; the next switch press starts again at the top. */
  idle(quiet = false): void {
    this.exitAll()
    this.clearTimer()
    this._state = 'idle'
    this.io.render(null)
    if (!quiet) this.io.announce('Scanning paused. Press your switch to start')
  }

  /** A switch press. False when it was ignored (off, bounce, busy). */
  press(role: SwitchRole): boolean {
    const now = this.io.now()
    if (this._state === 'off' || this._state === 'busy') return false
    if (now - this.lastPress < DEBOUNCE_MS) return false
    this.lastPress = now
    if (this._state === 'idle') {
      this.start()
      return true
    }
    if (role === 'next' && this.io.settings().mode === 'step') {
      this.advance()
      return true
    }
    void this.selectCurrent()
    return true
  }

  // ---- internals ----

  private top(): Frame | undefined {
    return this.stack[this.stack.length - 1]
  }

  private frame(level: ScanLevel, isRoot: boolean): Frame {
    const extra: ScanItem = isRoot
      ? { label: PAUSE_LABEL, select: () => 'idle' }
      : { label: BACK_LABEL, select: () => 'back' }
    return { level, items: [...level.items, extra] }
  }

  private enter(level: ScanLevel, isRoot: boolean): void {
    this.top()?.level.onHighlight?.(null)
    this.stack.push(this.frame(level, isRoot))
    this.reset()
  }

  private reset(): void {
    this.index = 0
    this.passes = 0
    this.show()
    this.schedule(FIRST_ITEM_FACTOR)
  }

  private exitAll(): void {
    while (this.stack.length) this.popFrame()
  }

  private popFrame(): void {
    const f = this.stack.pop()
    if (!f) return
    f.level.onHighlight?.(null)
    f.level.onExit?.()
  }

  private show(): void {
    const f = this.top()
    if (!f) return
    const item = f.items[this.index]
    f.level.onHighlight?.(this.index)
    this.io.render({
      title: f.level.title,
      items: f.items.map((i) => ({ label: i.label, rect: i.rect, n: i.n })),
      index: this.index,
      anchor: f.level.anchor,
      external: !!f.level.external
    })
    if (item) this.io.announce(item.label)
  }

  private schedule(factor = 1): void {
    this.clearTimer()
    const s = this.io.settings()
    if (s.mode !== 'auto' || this._state !== 'scanning') return
    this.timer = this.io.setTimeout(
      () => {
        this.timer = null
        this.advance()
      },
      Math.round(s.intervalMs * factor)
    )
  }

  private clearTimer(): void {
    if (this.timer !== null) this.io.clearTimeout(this.timer)
    this.timer = null
  }

  private advance(): void {
    const f = this.top()
    if (!f || this._state !== 'scanning') return
    this.index++
    if (this.index >= f.items.length) {
      this.index = 0
      this.passes++
      const s = this.io.settings()
      if (s.mode === 'auto' && this.passes >= s.loops) {
        if (this.stack.length > 1) this.back()
        else this.idle()
        return
      }
    }
    this.show()
    this.schedule()
  }

  private back(): void {
    if (this.stack.length <= 1) {
      this.reset()
      return
    }
    this.popFrame()
    this.reset()
  }

  private async selectCurrent(): Promise<void> {
    const item = this.current()
    if (!item) return
    this.clearTimer()
    this._state = 'busy'
    let result: ScanResult
    try {
      result = await item.select()
    } catch (e) {
      this.io.log(`scan: "${item.label}" failed (${(e as Error).message})`)
      result = 'stay'
    }
    // Stopped while the action ran (Escape, "stop scanning").
    if (this._state !== 'busy') return
    this._state = 'scanning'
    this.apply(result)
  }

  private apply(result: ScanResult): void {
    if (result === 'idle') return this.idle()
    if (result === 'root') return this.start()
    if (result === 'back') return this.back()
    if (result === 'stay') {
      this.show()
      this.schedule()
      return
    }
    if ('push' in result) return this.enter(result.push, false)
    // replace: same depth, the old level's onExit does not run.
    const isRoot = this.stack.length <= 1
    this.stack.pop()?.level.onHighlight?.(null)
    this.stack.push(this.frame(result.replace, isRoot))
    this.reset()
  }
}

/** Rows of items in reading order (by centre y, then x), each split into chunks of `max`. */
export function scanRows<T extends { rect: Rect }>(items: T[], max = 8): T[][] {
  const cy = (r: Rect): number => r.y + r.h / 2
  const sorted = [...items].sort((a, b) => cy(a.rect) - cy(b.rect) || a.rect.x - b.rect.x)
  const rows: T[][] = []
  let row: T[] = []
  let rowY = 0
  let rowH = 0
  for (const it of sorted) {
    const y = cy(it.rect)
    if (row.length && Math.abs(y - rowY) > Math.max(8, rowH / 2)) {
      rows.push(row)
      row = []
    }
    if (!row.length) {
      rowY = y
      rowH = it.rect.h
    }
    row.push(it)
  }
  if (row.length) rows.push(row)
  const out: T[][] = []
  for (const r of rows) {
    r.sort((a, b) => a.rect.x - b.rect.x)
    for (let i = 0; i < r.length; i += max) out.push(r.slice(i, i + max))
  }
  return out
}

export function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const r = Math.max(...rects.map((q) => q.x + q.w))
  const b = Math.max(...rects.map((q) => q.y + q.h))
  return { x, y, w: r - x, h: b - y }
}

/** The screen layer part for a view: a ring on items with a rect, else the level's menu. */
export function toScanScene(view: ScanView | null, fallbackAnchor: Point): ScanScene | undefined {
  if (!view || view.external) return undefined
  const item = view.items[view.index]
  if (!item) return undefined
  if (item.rect) return { ring: { rect: item.rect, label: item.label, n: item.n } }
  return {
    menu: {
      title: view.title,
      items: view.items.map((i) => i.label),
      index: view.index,
      at: view.anchor ?? fallbackAnchor
    }
  }
}
