// "What changed?" (11 T20), pure: a before/after diff of the foreground window, its UIA tree
// and a small grayscale screenshot, told in plain words. The "before" is taken when a command
// starts (only while helpers.whatChanged is on); nothing leaves the PC.
import type { ElementNode } from '@shared/types'

export interface Gray {
  w: number
  h: number
  data: Uint8Array
}

export interface ScreenState {
  at: number
  title: string
  process?: string
  /** Named elements of the foreground window (role + name; values only as a hash-free flag). */
  elements: { role: string; name: string; value?: string; focused?: boolean }[]
  gray?: Gray | null
}

const ROLE_WORD: Record<string, string> = {
  button: 'button',
  edit: 'field',
  combobox: 'box',
  checkbox: 'checkbox',
  radiobutton: 'option',
  menuitem: 'menu item',
  tabitem: 'tab',
  listitem: 'item',
  treeitem: 'item',
  hyperlink: 'link',
  window: 'window',
  text: 'text',
  dialog: 'dialog'
}
const SKIP_ROLES = new Set([
  'pane',
  'group',
  'custom',
  'separator',
  'thumb',
  'scrollbar',
  'image',
  'titlebar'
])
const MAX_LIST = 4
/** Mean abs difference (0..1) above which a cell counts as changed. */
export const CELL_CHANGED = 0.03

export function elementsOf(nodes: ElementNode[]): ScreenState['elements'] {
  const out: ScreenState['elements'] = []
  for (const n of nodes) {
    const name = n.name?.replace(/\s+/g, ' ').trim()
    if (!name || SKIP_ROLES.has(n.role) || name.length > 80) continue
    out.push({ role: n.role, name, value: n.value, focused: n.focused })
    if (out.length >= 600) break
  }
  return out
}

const keyOf = (e: { role: string; name: string }): string => `${e.role}\u0000${e.name}`

function describe(e: { role: string; name: string }): string {
  const word = ROLE_WORD[e.role]
  return word && e.role !== 'text' ? `“${e.name}” ${word}` : `“${e.name}”`
}

const list = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const AREAS = [
  ['top left', 'top', 'top right'],
  ['left', 'middle', 'right'],
  ['bottom left', 'bottom', 'bottom right']
]

/** Grid cells (3×3) that changed, by name, and the share of the screen that changed. */
export function changedAreas(a: Gray, b: Gray): { areas: string[]; share: number } | null {
  if (a.w !== b.w || a.h !== b.h || !a.w || !a.h) return null
  const areas: string[] = []
  let changedCells = 0
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const x0 = Math.floor((gx * a.w) / 3)
      const x1 = Math.floor(((gx + 1) * a.w) / 3)
      const y0 = Math.floor((gy * a.h) / 3)
      const y1 = Math.floor(((gy + 1) * a.h) / 3)
      let sum = 0
      for (let y = y0; y < y1; y++) {
        const row = y * a.w
        for (let x = x0; x < x1; x++) sum += Math.abs(a.data[row + x] - b.data[row + x])
      }
      const n = (x1 - x0) * (y1 - y0)
      if (n && sum / (n * 255) > CELL_CHANGED) {
        areas.push(AREAS[gy][gx])
        changedCells++
      }
    }
  }
  return { areas, share: changedCells / 9 }
}

/** The plain-words answer to "what changed?". */
export function describeChange(before: ScreenState | null, after: ScreenState): string {
  if (!before)
    return 'I don’t have a “before” to compare with yet. Ask again after your next command.'
  const lines: string[] = []
  if (before.title !== after.title || before.process !== after.process) {
    lines.push(
      after.title
        ? `The window in front is now “${after.title}”${before.title ? ` (it was “${before.title}”)` : ''}.`
        : 'The window in front changed.'
    )
  }
  const was = new Set(before.elements.map(keyOf))
  const now = new Set(after.elements.map(keyOf))
  const added = after.elements.filter((e) => !was.has(keyOf(e)))
  const removed = before.elements.filter((e) => !now.has(keyOf(e)))
  const windows = added.filter((e) => e.role === 'window' || e.role === 'dialog')
  if (windows.length)
    lines.push(`New window: ${list(windows.slice(0, 2).map((e) => `“${e.name}”`))}.`)
  const other = added.filter((e) => e.role !== 'window' && e.role !== 'dialog')
  if (other.length) {
    const more = other.length > MAX_LIST ? `, and ${other.length - MAX_LIST} more` : ''
    lines.push(`New: ${list(other.slice(0, MAX_LIST).map(describe))}${more}.`)
  }
  if (removed.length) {
    const more = removed.length > MAX_LIST ? `, and ${removed.length - MAX_LIST} more` : ''
    lines.push(`Gone: ${list(removed.slice(0, MAX_LIST).map(describe))}${more}.`)
  }
  const prevValues = new Map(before.elements.map((e) => [keyOf(e), e.value]))
  const edited = after.elements.filter(
    (e) => was.has(keyOf(e)) && e.value !== undefined && prevValues.get(keyOf(e)) !== e.value
  )
  if (edited.length) lines.push(`Changed: ${list(edited.slice(0, MAX_LIST).map(describe))}.`)
  const fBefore = before.elements.find((e) => e.focused)
  const fAfter = after.elements.find((e) => e.focused)
  if (fAfter && (!fBefore || keyOf(fBefore) !== keyOf(fAfter)))
    lines.push(`The keyboard is now on ${describe(fAfter)}.`)
  if (before.gray && after.gray) {
    const c = changedAreas(before.gray, after.gray)
    if (c && c.areas.length) {
      const where = c.share > 0.7 ? 'almost the whole screen' : `the ${list(c.areas)}`
      lines.push(
        `On screen, ${where} ${c.share > 0.7 ? 'changed' : c.areas.length > 1 ? 'parts changed' : 'part changed'}.`
      )
    } else if (c && !lines.length) {
      return 'Nothing visible changed since your last command.'
    }
  }
  if (!lines.length) return 'I can’t see any change in this window since your last command.'
  return lines.join(' ')
}
