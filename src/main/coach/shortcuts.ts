// Shortcut coach (11 T17), pure. Counts menu commands the user clicks (UIA "invoked" events,
// observe-only, local) that have a shortcut; after `after` uses it offers the shortcut once,
// then at most once a day, three times in all. Key combos the user presses (observe-only
// key-combo events, never typing) count as adoption: three uses and the tip stops for good.
// "voice" mode suggests a spoken command instead of a chord (users who can't press chords).

export interface CoachEntry {
  app: string
  action: string
  combo: string
  /** Menu uses. */
  menu: number
  /** Times the shortcut itself was pressed. */
  keys: number
  tips: number
  lastTip?: number
  learned?: boolean
}

export interface CoachState {
  entries: Record<string, CoachEntry>
  muted?: boolean
}

export interface CoachOpts {
  after: number
  mode: 'keys' | 'voice'
}

const DAY_MS = 86_400_000
export const MAX_TIPS = 3
export const LEARNED_AFTER = 3
const MAX_ENTRIES = 500

/** Shortcuts most Windows apps share (menu item name → combo). */
export const COMMON_SHORTCUTS: Record<string, string> = {
  save: 'Ctrl+S',
  'save as': 'Ctrl+Shift+S',
  open: 'Ctrl+O',
  new: 'Ctrl+N',
  print: 'Ctrl+P',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  'select all': 'Ctrl+A',
  find: 'Ctrl+F',
  replace: 'Ctrl+H',
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  underline: 'Ctrl+U',
  'zoom in': 'Ctrl+Plus',
  'zoom out': 'Ctrl+Minus',
  'new tab': 'Ctrl+T',
  'new window': 'Ctrl+N',
  refresh: 'F5',
  reload: 'F5',
  exit: 'Alt+F4'
}

const COMBO_RE =
  /^(?:(?:ctrl|alt|shift|win)\+)+[a-z0-9]+$|^(?:(?:ctrl|alt|shift|win)\+)*[a-z0-9]+$/i
const ACCEL_IN_NAME =
  /(?:\t|\s{2,}|\s\(|\s)((?:(?:ctrl|alt|shift)\+)+(?:[a-z0-9]|f\d{1,2}|plus|minus|del|delete|ins|insert|enter|tab|space|home|end)|f\d{1,2})\)?$/i

/** "Ctrl + shift + s" → "Ctrl+Shift+S". */
export function canonCombo(raw: string): string {
  return raw
    .replace(/\s*\+\s*/g, '+')
    .trim()
    .split('+')
    .map((k) => {
      const l = k.toLowerCase()
      if (l === 'control') return 'Ctrl'
      if (l === 'del') return 'Delete'
      if (/^f\d{1,2}$/.test(l)) return l.toUpperCase()
      return l.length === 1 ? l.toUpperCase() : l.charAt(0).toUpperCase() + l.slice(1)
    })
    .join('+')
}

/** "Save\tCtrl+S" / "Save (Ctrl+S)" → { action: "save", combo: "Ctrl+S" }. */
export function splitAccelerator(name: string): { action: string; combo: string | null } {
  const m = ACCEL_IN_NAME.exec(name.trim())
  if (!m) return { action: normAction(name), combo: null }
  return { action: normAction(name.slice(0, m.index)), combo: canonCombo(m[1]) }
}

/** Menu item names compare without "&" mnemonics, dots and case. */
export function normAction(name: string): string {
  return name
    .replace(/&/g, '')
    .replace(/\.{2,}|…/g, '')
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Key-combo rows of an app pack's shortcuts.md table: action → combo. */
export function parseShortcutTable(md: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const [action, shortcut] = [cells[1], cells[2]]
    if (!action || !shortcut || /^-+$/.test(action) || /^action$/i.test(action)) continue
    const combo = canonCombo(shortcut.split(/\s+or\s+|,/)[0])
    if (!COMBO_RE.test(combo) || !/\+|^F\d/.test(combo)) continue
    out[normAction(action)] ??= combo
  }
  return out
}

/** The combo for a menu command: its own accelerator text, the app pack, then the common list. */
export function shortcutFor(
  name: string,
  pack: Record<string, string> | null
): { action: string; combo: string } | null {
  const { action, combo } = splitAccelerator(name)
  if (!action) return null
  const found = combo ?? pack?.[action] ?? COMMON_SHORTCUTS[action] ?? null
  return found ? { action, combo: found } : null
}

/** How a combo is said for the voice grammar: "Ctrl+Shift+S" → "control shift S". */
export function spokenCombo(combo: string): string {
  return combo
    .split('+')
    .map((k) => (k === 'Ctrl' ? 'control' : k.length === 1 ? k : k.toLowerCase()))
    .join(' ')
}

export function tipText(e: Pick<CoachEntry, 'action' | 'combo'>, mode: CoachOpts['mode']): string {
  const action = e.action.charAt(0).toUpperCase() + e.action.slice(1)
  if (mode === 'voice')
    return `Tip: instead of the menu for ${action}, you can say “press ${spokenCombo(e.combo)}”.`
  return `Tip: ${e.combo} does ${action}. Want to try it next time? Say “stop shortcut tips” to turn these off.`
}

const keyOf = (app: string, action: string): string => `${app}\u0000${action}`

export class ShortcutCoach {
  constructor(
    private state: CoachState,
    private readonly opts: () => CoachOpts
  ) {}

  snapshot(): CoachState {
    return this.state
  }

  setMuted(muted: boolean): void {
    this.state = { ...this.state, muted }
  }

  /**
   * A menu item (or a button with a shortcut in its name) was invoked. Returns the tip to show,
   * or null.
   */
  onInvoke(
    app: string,
    name: string,
    pack: Record<string, string> | null,
    now: number
  ): string | null {
    const hit = shortcutFor(name, pack)
    if (!hit) return null
    const key = keyOf(app, hit.action)
    const prev = this.state.entries[key]
    const e: CoachEntry = prev
      ? { ...prev, combo: hit.combo, menu: prev.menu + 1 }
      : { app, action: hit.action, combo: hit.combo, menu: 1, keys: 0, tips: 0 }
    this.put(key, e)
    if (this.state.muted || e.learned || e.menu < this.opts().after || e.tips >= MAX_TIPS)
      return null
    if (e.lastTip !== undefined && now - e.lastTip < DAY_MS) return null
    this.put(key, { ...e, tips: e.tips + 1, lastTip: now })
    return tipText(e, this.opts().mode)
  }

  /** The user pressed a shortcut; returns the entry when it just became learned. */
  onCombo(app: string, combo: string): CoachEntry | null {
    const c = canonCombo(combo)
    for (const [key, e] of Object.entries(this.state.entries)) {
      if (e.app !== app || e.learned || canonCombo(e.combo) !== c) continue
      const keys = e.keys + 1
      const learned = keys >= LEARNED_AFTER
      this.put(key, { ...e, keys, learned })
      return learned ? { ...e, keys, learned } : null
    }
    return null
  }

  learned(): CoachEntry[] {
    return Object.values(this.state.entries).filter((e) => e.learned)
  }

  private put(key: string, e: CoachEntry): void {
    const entries = { ...this.state.entries, [key]: e }
    const keys = Object.keys(entries)
    // Oldest unlearned first out when the list is full.
    if (keys.length > MAX_ENTRIES) {
      const drop = keys.find((k) => !entries[k].learned && k !== key)
      if (drop) delete entries[drop]
    }
    this.state = { ...this.state, entries }
  }
}
