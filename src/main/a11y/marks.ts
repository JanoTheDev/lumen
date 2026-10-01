// "Show numbers" model (06 T06): numbered marks over the clickable controls of the foreground
// window, built from the UIA snapshot (OCR lines fill in when UIA finds fewer than 5), in
// reading order, 99 per page. 05's set-of-marks table is reused when it is fresh. Pure state;
// the dispatcher fetches snapshots and draws the scene.
import type { ElementNode, Rect } from '@shared/types'
import type { OcrWord } from '../agent/commands'
import { buildMarks, type Mark, type MarksTable } from '../query/marks'
import { isInteractive } from '../query/uia-list'

export type { Mark, MarksTable }

export const PAGE_SIZE = 99
export const MIN_UIA_MARKS = 5
/** 05's per-turn table is reused when built this recently. */
export const REUSE_MS = 5000

export type MarkRole = 'links' | 'buttons' | 'fields' | 'menus' | 'tabs' | 'checkboxes'

const ROLES: Record<MarkRole, (n: ElementNode) => boolean> = {
  links: (n) => n.role === 'hyperlink',
  buttons: (n) => n.role === 'button' || n.role === 'splitbutton',
  fields: (n) =>
    n.role === 'edit' ||
    n.role === 'combobox' ||
    (n.role === 'document' && n.patterns.includes('value')),
  menus: (n) => n.role === 'menuitem' || n.role === 'menu' || n.role === 'menubar',
  tabs: (n) => n.role === 'tabitem',
  checkboxes: (n) => n.role === 'checkbox' || n.role === 'radiobutton'
}

export function isMarkRole(r: unknown): r is MarkRole {
  return typeof r === 'string' && r in ROLES
}

export interface ScreenMarksInput {
  nodes: ElementNode[]
  ocrLines?: OcrWord[]
  /** Physical rect the marks must fall in (foreground window or monitor). */
  area: Rect
  role?: MarkRole
}

/** Interactive, enabled nodes (role-filtered) + OCR lines when UIA is thin, numbered from 1. */
export function buildScreenMarks(input: ScreenMarksInput): MarksTable {
  const keep = input.role ? ROLES[input.role] : null
  const nodes = input.nodes.filter(
    (n) => isInteractive(n) && n.enabled !== false && (!keep || keep(n))
  )
  const useOcr = !input.role && nodes.length < MIN_UIA_MARKS
  return buildMarks({
    nodes,
    ocrLines: useOcr ? (input.ocrLines ?? []) : [],
    frame: input.area,
    quality: 'none',
    max: 999
  })
}

/** Whether 05's table can stand in for a fresh snapshot. */
export function reusable(
  table: MarksTable | undefined,
  builtAt: number,
  now: number
): table is MarksTable {
  return !!table && table.length >= MIN_UIA_MARKS && now - builtAt <= REUSE_MS
}

export class MarksState {
  table: MarksTable = []
  page = 0
  shown = false
  role?: MarkRole
  snapshotId?: string

  show(table: MarksTable, opts: { role?: MarkRole; snapshotId?: string } = {}): void {
    this.table = table
    this.page = 0
    this.shown = table.length > 0
    this.role = opts.role
    this.snapshotId = opts.snapshotId
  }

  hide(): void {
    this.shown = false
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.table.length / PAGE_SIZE))
  }

  /** Next page, wrapping to the first; false when there is only one page. */
  nextPage(): boolean {
    if (this.pages <= 1) return false
    this.page = (this.page + 1) % this.pages
    return true
  }

  /** Marks on the current page, renumbered from 1. */
  visible(): Mark[] {
    return this.table
      .slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)
      .map((m, i) => ({ ...m, n: i + 1 }))
  }

  find(n: number): Mark | undefined {
    return this.shown ? this.visible().find((m) => m.n === n) : undefined
  }
}

/** Exact (case-insensitive) control name match for "click <name>"; one hit or none. */
export function findByName(nodes: ElementNode[], spoken: string): ElementNode | null {
  const want = spoken
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+(button|link|tab|menu|field|checkbox|icon)$/, '')
    .trim()
  if (!want) return null
  const hits = nodes.filter(
    (n) => isInteractive(n) && n.enabled !== false && n.name.trim().toLowerCase() === want
  )
  return hits.length === 1 ? hits[0] : null
}
