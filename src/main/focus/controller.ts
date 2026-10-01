// Focus mode state (11 T14). Manual: "focus mode on" keeps the foreground window (or the pack
// regions the user named) clear and dims the rest. Auto: while a lesson step shows its target
// and helpers.focusWithLessons is on, only that target stays clear. "show everything" / "focus
// mode off" always clears it. The layer stays click-through, so nothing is ever out of reach.
import type { FocusScene } from '@shared/events'
import type { Rect } from '@shared/types'
import { buildFocusScene, matchRegions, packRegions, type NamedRegion } from './mask'

export interface ForegroundLike {
  /** Physical px. */
  rect: Rect
  process?: string
  title?: string
}

export interface FocusIo {
  foreground(): Promise<ForegroundLike | null>
  /** Pack regions (fractions of the window) of the app in front, if it has a pack. */
  regions(
    win: ForegroundLike
  ): Record<string, { x: number; y: number; w: number; h: number; desc?: string }> | null
  physRectToLogical(r: Rect): Rect
  draw(scene: FocusScene | null): void
  level(): FocusScene['level']
  autoWithLessons(): boolean
}

export type FocusResult = { ok: true; text: string } | { ok: false; text: string }

type Mode =
  | { kind: 'off' }
  | { kind: 'manual'; region?: string; win?: Rect }
  | { kind: 'lesson'; keep: Rect[] }

export class FocusController {
  private mode: Mode = { kind: 'off' }
  /** Lesson targets seen last, so turning auto on mid-step can use them. */
  private lessonKeep: Rect[] = []
  private levelOverride: FocusScene['level'] | null = null

  constructor(private readonly io: FocusIo) {}

  get active(): boolean {
    return this.mode.kind !== 'off'
  }

  get manual(): boolean {
    return this.mode.kind === 'manual'
  }

  private level(): FocusScene['level'] {
    return this.levelOverride ?? this.io.level()
  }

  /** "focus mode on" / "focus on the viewport" / "strong focus". */
  async on(opts: { region?: string; level?: FocusScene['level'] } = {}): Promise<FocusResult> {
    if (opts.level) this.levelOverride = opts.level
    const win = await this.io.foreground()
    if (!win)
      return { ok: false, text: 'I can’t see which window is in front, so focus mode stays off.' }
    const regions = this.namedRegions(win)
    let keep: NamedRegion[] = []
    if (opts.region) {
      keep = matchRegions(opts.region, regions)
      if (!keep.length) {
        const names = regions.map((r) => r.name.replace(/-/g, ' ')).slice(0, 6)
        return {
          ok: false,
          text: names.length
            ? `I don’t know a “${opts.region}” area here. Try: ${names.join(', ')}.`
            : `I don’t know the areas of this app, so I can only focus on the whole window. Say “focus mode on”.`
        }
      }
    }
    this.mode = { kind: 'manual', region: opts.region, win: win.rect }
    const scene = this.manualScene(
      win,
      keep.map((r) => r.rect),
      regions
    )
    this.io.draw(scene)
    const what = keep.length
      ? keep.map((r) => r.name.replace(/-/g, ' ')).join(' and ')
      : 'this window'
    return {
      ok: true,
      text: `Focus mode on: ${what} stays clear. Everything else is dimmed but still clickable. Say “show everything” to undo.`
    }
  }

  /** "focus mode off" / "show everything". */
  off(): FocusResult {
    const was = this.active
    this.mode = { kind: 'off' }
    this.levelOverride = null
    this.io.draw(null)
    return { ok: true, text: was ? 'Showing everything.' : 'Nothing is dimmed.' }
  }

  /** The foreground window moved or changed: redraw a manual focus around it. */
  async refresh(): Promise<void> {
    if (this.mode.kind !== 'manual') return
    const win = await this.io.foreground()
    if (!win || this.mode.kind !== 'manual') return
    if (sameRect(win.rect, this.mode.win)) return
    const regions = this.namedRegions(win)
    const keep = this.mode.region ? matchRegions(this.mode.region, regions) : []
    this.mode = { ...this.mode, win: win.rect }
    this.io.draw(
      this.manualScene(
        win,
        keep.map((r) => r.rect),
        regions
      )
    )
  }

  /** A lesson step drew its targets (logical px), or null when the lesson scene cleared. */
  lessonTargets(rects: Rect[] | null): void {
    this.lessonKeep = rects ?? []
    if (this.mode.kind === 'manual') return
    if (!this.io.autoWithLessons() || !this.lessonKeep.length) {
      if (this.mode.kind === 'lesson') {
        this.mode = { kind: 'off' }
        this.io.draw(null)
      }
      return
    }
    this.mode = { kind: 'lesson', keep: this.lessonKeep }
    this.io.draw(buildFocusScene(this.level(), this.lessonKeep))
  }

  /** Settings changed (level or the lesson switch): redraw what is shown. */
  async settingsChanged(): Promise<void> {
    if (this.mode.kind === 'manual') {
      this.mode = { ...this.mode, win: undefined }
      await this.refresh()
    } else this.lessonTargets(this.lessonKeep)
  }

  private namedRegions(win: ForegroundLike): NamedRegion[] {
    const regions = this.io.regions(win)
    if (!regions) return []
    return packRegions(win.rect, regions).map((r) => ({
      ...r,
      rect: this.io.physRectToLogical(r.rect)
    }))
  }

  private manualScene(
    win: ForegroundLike,
    keepRegions: Rect[],
    regions: NamedRegion[]
  ): FocusScene | null {
    const keep = keepRegions.length ? keepRegions : [this.io.physRectToLogical(win.rect)]
    return buildFocusScene(this.level(), keep, keepRegions.length ? regions : [])
  }
}

function sameRect(a: Rect, b: Rect | undefined): boolean {
  return !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
