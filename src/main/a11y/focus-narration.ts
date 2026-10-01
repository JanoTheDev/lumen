// Focus narration (06 T12): the agent's `focus-changed` event becomes a short spoken line,
// "Send, button". For low-vision users without a screen reader, so it stays quiet while one
// runs (it would speak twice). Fast tabbing only speaks where focus settles.

export interface FocusElement {
  name?: unknown
  role?: unknown
  value?: unknown
  enabled?: unknown
}

export interface FocusNarratorDeps {
  /** a11y.focusNarration. */
  enabled(): boolean
  screenReaderActive(): boolean
  announce(text: string): void
  /** Turns the agent's focus-changed events on or off. */
  subscribe(on: boolean): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Wait this long after the last focus change before speaking. */
export const SETTLE_MS = 250
/** The same element (re)focused within this window is not spoken again. */
export const REPEAT_MS = 2000
const MAX_NAME = 80
const MAX_VALUE = 60

const ROLE_WORD: Record<string, string> = {
  edit: 'edit',
  document: 'document',
  hyperlink: 'link',
  menuitem: 'menu item',
  tabitem: 'tab',
  treeitem: 'tree item',
  listitem: 'list item',
  checkbox: 'check box',
  radiobutton: 'radio button',
  combobox: 'combo box',
  splitbutton: 'split button',
  dataitem: 'cell',
  scrollbar: 'scroll bar'
}
const VALUE_ROLES = new Set(['edit', 'combobox', 'slider', 'spinner'])
const SILENT_ROLES = new Set(['pane', 'window', 'group', 'custom', ''])

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "Send, button", "Search, edit, cats", "Save, button, unavailable"; null = nothing to say. */
export function describeFocus(el: FocusElement | null | undefined): string | null {
  if (!el || typeof el !== 'object') return null
  const name = typeof el.name === 'string' ? clip(el.name, MAX_NAME) : ''
  const roleRaw = typeof el.role === 'string' ? el.role.toLowerCase() : ''
  const role = ROLE_WORD[roleRaw] ?? roleRaw
  if (!name && SILENT_ROLES.has(roleRaw)) return null
  const parts = [name, SILENT_ROLES.has(roleRaw) ? '' : role]
  if (VALUE_ROLES.has(roleRaw) && typeof el.value === 'string' && el.value.trim())
    parts.push(clip(el.value, MAX_VALUE))
  if (el.enabled === false) parts.push('unavailable')
  const text = parts.filter(Boolean).join(', ')
  return text || null
}

export class FocusNarrator {
  private subscribed = false
  private pending: unknown = null
  private latest: string | null = null
  private last: { text: string; at: number } | null = null

  constructor(
    private readonly deps: FocusNarratorDeps,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Narration runs when it is on and no screen reader is speaking already. */
  get active(): boolean {
    return this.deps.enabled() && !this.deps.screenReaderActive()
  }

  /** Re-checks config and screen reader; (un)subscribes on change. */
  sync(): void {
    const want = this.active
    if (want === this.subscribed) return
    this.subscribed = want
    this.deps.subscribe(want)
    if (!want) this.cancel()
  }

  onFocusChanged(data: unknown): void {
    if (!this.active) return
    const el = (data as { element?: FocusElement } | null)?.element
    const text = describeFocus(el)
    if (!text) return
    this.latest = text
    if (this.pending) this.deps.clearTimeout(this.pending)
    this.pending = this.deps.setTimeout(() => this.flush(), SETTLE_MS)
  }

  private flush(): void {
    this.pending = null
    const text = this.latest
    this.latest = null
    if (!text || !this.active) return
    const now = this.now()
    if (this.last && this.last.text === text && now - this.last.at < REPEAT_MS) return
    this.last = { text, at: now }
    this.deps.announce(text)
  }

  private cancel(): void {
    if (this.pending) this.deps.clearTimeout(this.pending)
    this.pending = null
    this.latest = null
  }
}
