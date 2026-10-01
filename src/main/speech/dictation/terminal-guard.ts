// Dictated text must never run a command: in a terminal it is typed without line breaks (so
// no Enter is ever sent), or not typed at all when the user chose to block terminals.
import { isShellWindow } from '../../actions/safety'

/** What dictation knows about the window and element that will receive the text. */
export interface FocusTarget {
  process: string
  title: string
  /** True when the role/editable fields came from UI Automation. */
  uia: boolean
  role: string
  name: string
  editable: boolean
  password: boolean
  /** Last characters of the field's current value, when readable. */
  valueTail: string
}

export type TerminalPolicy = 'type-no-enter' | 'block'

export const TERMINAL_PROCESSES = new Set([
  'windowsterminal.exe',
  'wt.exe',
  'cmd.exe',
  'powershell.exe',
  'powershell_ise.exe',
  'pwsh.exe',
  'conhost.exe',
  'openconsole.exe',
  'wsl.exe',
  'wslhost.exe',
  'bash.exe',
  'mintty.exe',
  'alacritty.exe',
  'wezterm-gui.exe',
  'hyper.exe',
  'tabby.exe',
  'warp.exe'
])

// Editors with an embedded terminal; it is detected from the focused element's name.
const EDITORS_WITH_TERMINAL = new Set([
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe'
])
const TERMINAL_ELEMENT_RE = /\bterminal\b/i

export function isTerminalTarget(t: Pick<FocusTarget, 'process' | 'title' | 'name'>): boolean {
  const proc = t.process.trim().toLowerCase()
  if (TERMINAL_PROCESSES.has(proc)) return true
  if (EDITORS_WITH_TERMINAL.has(proc) && TERMINAL_ELEMENT_RE.test(t.name)) return true
  // No process known: judge by the title.
  return !proc && isShellWindow(t.title)
}

/**
 * IDEs whose focused element UI Automation cannot see (JetBrains and Android Studio are
 * Swing, Zed and Fleet draw their own UI), so their terminal tool window looks like the
 * editor. The agent refuses a line break there, and Enter right after typing; dictation
 * types one line and never presses Enter in them.
 */
export const OPAQUE_IDES = new Set([
  'idea64.exe',
  'idea.exe',
  'pycharm64.exe',
  'webstorm64.exe',
  'rider64.exe',
  'clion64.exe',
  'goland64.exe',
  'phpstorm64.exe',
  'rubymine64.exe',
  'datagrip64.exe',
  'studio64.exe',
  'zed.exe',
  'fleet.exe'
])

export function isOpaqueIde(t: Pick<FocusTarget, 'process'>): boolean {
  return OPAQUE_IDES.has(t.process.trim().toLowerCase())
}

export const OPAQUE_IDE_NOTICE =
  'Typed on one line: this IDE may have its terminal focused, so no line breaks or Enter here.'

export type GuardDecision =
  | { kind: 'type'; text: string; terminal: false; notice?: string }
  | { kind: 'type'; text: string; terminal: true; notice: string }
  | { kind: 'block'; notice: string }

export const TERMINAL_NOTICE = 'Dictation typed into a terminal. Press Enter yourself to run it.'
export const TERMINAL_BLOCKED = 'Dictation is turned off for terminals.'

/** Strips control characters; keeps tabs and line breaks for normal fields. */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** One line, no trailing break: typing it can never press Enter. */
export function flattenForTerminal(text: string): string {
  return sanitize(text)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function guardText(
  text: string,
  target: FocusTarget,
  policy: TerminalPolicy
): GuardDecision {
  if (isOpaqueIde(target) && !isTerminalTarget(target)) {
    // A line break could run a command in the IDE's terminal: one line, never an Enter.
    const clean = sanitize(text)
    return /[\r\n\u2028\u2029]/.test(clean)
      ? {
          kind: 'type',
          text: flattenForTerminal(clean),
          terminal: false,
          notice: OPAQUE_IDE_NOTICE
        }
      : { kind: 'type', text: clean, terminal: false }
  }
  if (!isTerminalTarget(target)) return { kind: 'type', text: sanitize(text), terminal: false }
  if (policy === 'block') return { kind: 'block', notice: TERMINAL_BLOCKED }
  return { kind: 'type', text: flattenForTerminal(text), terminal: true, notice: TERMINAL_NOTICE }
}
