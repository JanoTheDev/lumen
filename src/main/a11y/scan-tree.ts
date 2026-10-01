// What switch scanning moves through (06 T09), in spec order: Lumen's own actions, numbers
// (rows of ≤ 8, then items), the mouse grid (cells), then an action menu on the picked
// point (click / double / right / drag / scroll / type). Pure: everything it touches comes
// in through ScanTreeDeps so tests can drive the whole tree.
import type { InputStep, Point, Rect } from '@shared/types'
import type { LessonCommand } from '@shared/events'
import type { GridScene } from './grid'
import { cellRect, center } from './grid'
import { scanRows, unionRect, type ScanItem, type ScanLevel, type ScanResult } from './switch'

export interface ScanMark {
  n: number
  label: string
  /** Global logical px. */
  rect: Rect
}

export interface ScanTreeDeps {
  /** Shows numbers for the foreground window; resolves with how many are up. */
  showNumbers(): Promise<number>
  numbers(): ScanMark[]
  hideNumbers(): void
  /** Opens the grid on the monitor under the cursor. */
  showGrid(): void
  grid(): GridScene | undefined
  gridSelect(n: number): boolean
  gridUp(): boolean
  gridAtMinimum(): boolean
  closeGrid(): void
  /** Agent input; points in the steps are logical and converted by the caller. */
  input(steps: InputStep[]): Promise<void>
  logicalToPhys(p: Point): Point
  /** Opens the scan keyboard and returns its level (rows, then keys). */
  keyboard(): ScanLevel
  /** Lumen's own actions (ask, repeat, pin, close, cancel, help, settings), in bar order. */
  lumenActions(): { label: string; run(): void }[]
  lessonRunning(): boolean
  lessonCommand(cmd: LessonCommand): void
  feedback(text: string, ok: boolean): void
}

const SCROLL_NOTCHES = 5

const LESSON: { label: string; cmd: LessonCommand }[] = [
  { label: 'Next step', cmd: 'next' },
  { label: 'Previous step', cmd: 'back' },
  { label: 'Repeat', cmd: 'repeat' },
  { label: 'Help', cmd: 'help' },
  { label: 'Do it for me', cmd: 'do-it' },
  { label: 'Stop lesson', cmd: 'stop' }
]

export class ScanTree {
  /** Drag start picked with "Start drag here", waiting for "Drop here". */
  dragFrom: Point | null = null

  constructor(private readonly d: ScanTreeDeps) {}

  root(): ScanLevel {
    const items: ScanItem[] = []
    if (this.d.lessonRunning())
      items.push({ label: 'Lesson', select: () => ({ push: this.lessonLevel() }) })
    items.push(
      { label: 'Lumen', select: () => ({ push: this.lumenLevel() }) },
      { label: 'Numbers', select: () => this.numbersLevel() },
      { label: 'Mouse grid', select: () => this.openGrid() },
      { label: 'Keyboard', select: () => ({ push: this.d.keyboard() }) }
    )
    return { title: this.dragFrom ? 'Pick where to drop' : 'Scanning', items }
  }

  lessonLevel(): ScanLevel {
    return {
      title: 'Lesson',
      items: LESSON.map((l) => ({
        label: l.label,
        select: (): ScanResult => {
          this.d.lessonCommand(l.cmd)
          return 'root'
        }
      }))
    }
  }

  lumenLevel(): ScanLevel {
    return {
      title: 'Lumen',
      items: this.d.lumenActions().map((a) => ({
        label: a.label,
        select: (): ScanResult => {
          a.run()
          return 'root'
        }
      }))
    }
  }

  // ---- numbers ----

  async numbersLevel(): Promise<ScanResult> {
    let marks = this.d.numbers()
    if (!marks.length) {
      const count = await this.d.showNumbers()
      marks = count ? this.d.numbers() : []
    }
    if (!marks.length) {
      this.d.feedback('Nothing to number here', false)
      return 'stay'
    }
    const markItem = (m: ScanMark): ScanItem => ({
      label: m.label ? `${m.n}, ${m.label}` : String(m.n),
      rect: m.rect,
      n: m.n,
      select: () => ({ push: this.actionMenu(center(m.rect), m.label || String(m.n)) })
    })
    const rows = scanRows(marks)
    const exit = (): void => this.d.hideNumbers()
    if (rows.length === 1)
      return { push: { title: 'Numbers', items: rows[0].map(markItem), onExit: exit } }
    return {
      push: {
        title: 'Numbers',
        onExit: exit,
        items: rows.map((row, i) => ({
          label: `Row ${i + 1}, ${row[0].label || row[0].n}`,
          rect: unionRect(row.map((m) => m.rect)),
          select: () => ({ push: { title: `Row ${i + 1}`, items: row.map(markItem) } })
        }))
      }
    }
  }

  // ---- grid ----

  private openGrid(): ScanResult {
    this.d.showGrid()
    const level = this.gridLevel()
    return level ? { push: level } : 'stay'
  }

  gridLevel(): ScanLevel | null {
    const g = this.d.grid()
    if (!g) return null
    const cells: ScanItem[] = Array.from({ length: g.cols * g.rows }, (_, i) => {
      const n = i + 1
      const rect = cellRect(g.rect, n, g.cols, g.rows)
      return {
        label: String(n),
        rect,
        n,
        select: (): ScanResult => {
          if (!this.d.gridAtMinimum() && this.d.gridSelect(n)) {
            const next = this.gridLevel()
            if (next) return { replace: next }
          }
          return { push: this.actionMenu(center(rect), `cell ${n}`) }
        }
      }
    })
    const extra: ScanItem[] = [
      {
        label: 'Act here',
        select: () => ({ push: this.actionMenu(center(g.rect), 'here') })
      }
    ]
    if (g.level > 0)
      extra.push({
        label: 'Zoom out',
        select: (): ScanResult => {
          this.d.gridUp()
          const next = this.gridLevel()
          return next ? { replace: next } : 'back'
        }
      })
    return {
      title: 'Mouse grid',
      items: [...cells, ...extra],
      anchor: center(g.rect),
      onExit: () => this.d.closeGrid()
    }
  }

  // ---- actions at a point ----

  actionMenu(p: Point, what: string): ScanLevel {
    const at = this.d.logicalToPhys(p)
    const click =
      (label: string, button: 'left' | 'right', count: number): (() => Promise<ScanResult>) =>
      async () => {
        await this.d.input([{ t: 'click', button, count, ...at }])
        this.d.feedback(`${label} ${what}`, true)
        return 'root'
      }
    const items: ScanItem[] = []
    if (this.dragFrom) {
      const from = this.d.logicalToPhys(this.dragFrom)
      items.push({
        label: 'Drop here',
        select: async (): Promise<ScanResult> => {
          this.dragFrom = null
          await this.d.input([{ t: 'drag', from, to: at }])
          this.d.feedback('Dropped', true)
          return 'root'
        }
      })
    }
    items.push(
      { label: 'Click', select: click('Clicked', 'left', 1) },
      { label: 'Double click', select: click('Double clicked', 'left', 2) },
      { label: 'Right click', select: click('Right clicked', 'right', 1) },
      {
        label: 'Start drag here',
        select: (): ScanResult => {
          this.dragFrom = p
          this.d.feedback('Drag start set. Pick where to drop', true)
          return 'root'
        }
      },
      { label: 'Scroll', select: () => ({ push: this.scrollLevel(p) }) },
      {
        label: 'Type here',
        select: async (): Promise<ScanResult> => {
          await this.d.input([{ t: 'click', button: 'left', ...at }])
          return { push: this.d.keyboard() }
        }
      }
    )
    return { title: `Action on ${what}`, items, anchor: p }
  }

  scrollLevel(p: Point): ScanLevel {
    const at = this.d.logicalToPhys(p)
    const dirs: [string, number, number][] = [
      ['Scroll up', 0, -1],
      ['Scroll down', 0, 1],
      ['Scroll left', -1, 0],
      ['Scroll right', 1, 0]
    ]
    return {
      title: 'Scroll',
      anchor: p,
      items: dirs.map(([label, dx, dy]) => ({
        label,
        select: async (): Promise<ScanResult> => {
          await this.d.input([
            { t: 'scroll', dx: dx * SCROLL_NOTCHES, dy: dy * SCROLL_NOTCHES, ...at }
          ])
          return 'stay'
        }
      }))
    }
  }
}
