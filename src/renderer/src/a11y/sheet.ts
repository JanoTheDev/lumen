// Command sheet rows → sections (pure, tested): search filter and grouping.
import type { CommandSheetRow } from '@shared/channels'

const CATEGORY_LABEL: Record<string, string> = {
  numbers: 'Numbers',
  grid: 'Mouse grid',
  pointer: 'Mouse',
  scroll: 'Scrolling',
  keyboard: 'Keyboard and typing',
  navigation: 'Apps and browsing',
  windows: 'Windows',
  reading: 'Describe and read',
  lumen: 'Lumen',
  guide: 'Guides'
}
const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL)

export interface Section {
  id: string
  title: string
  rows: CommandSheetRow[]
}

/** Rows that match every word of the query (say, does or when). */
export function filterRows(rows: CommandSheetRow[], query: string): CommandSheetRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  return rows.filter((r) => {
    const hay = `${r.say} ${r.does} ${r.when ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** "Right now" first (commands that only apply in the current state), then by category. */
export function buildSections(rows: CommandSheetRow[]): Section[] {
  const out: Section[] = []
  const now = rows.filter((r) => r.when && r.now)
  if (now.length) out.push({ id: 'now', title: 'Right now', rows: now })
  const rest = rows.filter((r) => !(r.when && r.now))
  const cats = [...new Set(rest.map((r) => r.category))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b)
  )
  for (const c of cats)
    out.push({ id: c, title: CATEGORY_LABEL[c] ?? c, rows: rest.filter((r) => r.category === c) })
  return out
}

function rank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category)
  return i < 0 ? CATEGORY_ORDER.length : i
}
