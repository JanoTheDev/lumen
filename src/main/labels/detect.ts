// Unnamed controls (11 T13): icon-only buttons, tabs and menu items whose UIA Name is empty or
// says nothing ("button", "icon", "btn_3", one character). Screen readers read these as
// "button, button, button". No Electron.
import type { ElementNode } from '@shared/types'
import { flattenElements, isInteractive } from '../query/uia-list'

/** Roles worth a label (text fields and list rows are named by their content). */
const LABEL_ROLES = new Set([
  'button',
  'splitbutton',
  'menuitem',
  'tabitem',
  'checkbox',
  'radiobutton',
  'hyperlink',
  'combobox',
  'slider',
  'image'
])

const GENERIC =
  /^(?:button|btn|icon|image|img|graphic|picture|unnamed|untitled|unknown|item|control|toolbar ?button|menu ?item|tab|link|check ?box|custom|\W*)$/i
/** Names made by a UI toolkit, not a person: "btn_3", "ImageButton12", "QToolButton". */
const MACHINE = /^(?:[a-z]+_\d+|[A-Z][a-z]+(?:[A-Z][a-z]+)+\d*|Q[A-Z][A-Za-z]+|\d+)$/

export function isGenericName(name: string, role?: string): boolean {
  const n = name.replace(/\s+/g, ' ').trim()
  if (n.length <= 1) return true
  if (GENERIC.test(n)) return true
  if (role && n.toLowerCase() === role.toLowerCase()) return true
  return MACHINE.test(n)
}

/** A control a user can act on that has no usable accessible name. */
export function isUnnamed(node: ElementNode): boolean {
  if (!LABEL_ROLES.has(node.role)) return false
  if (node.role !== 'image' && !isInteractive(node)) return false
  if (node.rect.w < 6 || node.rect.h < 6 || node.rect.w > 400 || node.rect.h > 200) return false
  return isGenericName(node.name ?? '', node.role)
}

/** Unnamed controls under `root`, top-left first, at most `max`. */
export function unnamedNodes(root: ElementNode, max = 16): ElementNode[] {
  const seen = new Set<string>()
  return flattenElements(root)
    .map((f) => f.node)
    .filter((n) => {
      if (!isUnnamed(n)) return false
      const k = `${n.rect.x},${n.rect.y},${n.rect.w},${n.rect.h}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .slice(0, max)
}

/** Named controls near `n` (same row or column, within 300 px), for context. */
export function neighbours(root: ElementNode, n: ElementNode, max = 4): string[] {
  const cx = n.rect.x + n.rect.w / 2
  const cy = n.rect.y + n.rect.h / 2
  return flattenElements(root)
    .map((f) => f.node)
    .filter((o) => o !== n && o.name && !isGenericName(o.name, o.role))
    .map((o) => ({
      name: o.name.trim().slice(0, 40),
      d: Math.hypot(o.rect.x + o.rect.w / 2 - cx, o.rect.y + o.rect.h / 2 - cy)
    }))
    .filter((o) => o.d < 300)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((o) => o.name)
}
