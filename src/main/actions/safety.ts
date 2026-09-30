// Central policy for anything the model can make Lumen do outside its own windows.
// Every URL launch and every synthesized keystroke goes through here.

export class SafetyError extends Error {
  readonly code = 'E_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'SafetyError'
  }
}

export type Verdict = 'allow' | 'confirm' | 'deny'

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/** Returns the normalized URL if it is a plain http(s) web address, otherwise throws SafetyError. */
export function assertSafeUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new SafetyError('URL is not a string')
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 4096) throw new SafetyError('URL empty or too long')
  // UNC paths and backslash tricks never make sense for a web URL.
  if (trimmed.startsWith('\\\\') || trimmed.includes('\\'))
    throw new SafetyError(`blocked path-like URL: ${trimmed}`)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new SafetyError(`invalid URL: ${trimmed}`)
  }
  if (!ALLOWED_SCHEMES.has(url.protocol))
    throw new SafetyError(`blocked URL scheme: ${url.protocol}`)
  if (url.username || url.password) throw new SafetyError('blocked URL with credentials')
  if (!url.hostname) throw new SafetyError('URL has no host')
  return url.toString()
}

export function isSafeUrl(raw: unknown): boolean {
  try {
    assertSafeUrl(raw)
    return true
  } catch {
    return false
  }
}

const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctl: 'ctrl',
  windows: 'win',
  super: 'win',
  meta: 'win',
  cmd: 'win',
  command: 'win',
  lwin: 'win',
  rwin: 'win',
  winleft: 'win',
  winright: 'win',
  option: 'alt',
  escape: 'esc',
  delete: 'del',
  return: 'enter'
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win']

/** Normalizes ["Control","Shift","Esc"] or "Ctrl+Shift+Escape" to "ctrl+shift+esc". */
export function normalizeCombo(keys: string[] | string): string {
  const list = Array.isArray(keys) ? keys : keys.split('+')
  const norm = list
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => KEY_ALIASES[k] ?? k)
  const mods = MODIFIER_ORDER.filter((m) => norm.includes(m))
  const rest = norm.filter((k) => !MODIFIER_ORDER.includes(k))
  return [...mods, ...rest].join('+')
}

// Windows where typed text can execute commands. Browser tabs about these topics are excluded.
const SHELL_TITLE_RE =
  /^run$|\bcmd(\.exe)?\b|command prompt|powershell|windows terminal|^(administrator: )?(terminal|bash|wsl|ubuntu)\b/i
const BROWSER_TITLE_RE =
  /(google chrome|mozilla firefox|microsoft\u200b? edge|brave|opera|vivaldi)$/i

export interface KeyContext {
  /** Title of the window that will receive the keys. */
  windowTitle?: string
  /** The previous action in this batch typed text. */
  afterType?: boolean
}

export function isShellWindow(title: string | undefined): boolean {
  if (!title) return false
  const t = title.trim()
  return SHELL_TITLE_RE.test(t) && !BROWSER_TITLE_RE.test(t)
}

export function classifyHotkey(keys: string[] | string, ctx: KeyContext = {}): Verdict {
  const combo = normalizeCombo(keys)
  const parts = combo.split('+')
  const isOwnWindow = !!ctx.windowTitle && /\blumen\b/i.test(ctx.windowTitle)

  if (combo === 'win+r' || combo === 'win+x') return 'deny'
  if (combo === 'ctrl+alt+del') return 'deny'
  if (combo === 'alt+f4') return isOwnWindow ? 'allow' : 'deny'
  if (parts.includes('win')) {
    if (combo === 'win+d' || combo === 'win+e') return 'confirm'
    return 'deny'
  }
  if (combo === 'ctrl+w' || combo === 'ctrl+shift+esc') return 'confirm'
  if (combo === 'enter' && ctx.afterType && isShellWindow(ctx.windowTitle)) return 'confirm'
  return 'allow'
}

/** Typing into a shell or the Run dialog can execute commands, so it needs the user's OK. */
export function classifyType(ctx: KeyContext = {}): Verdict {
  return isShellWindow(ctx.windowTitle) ? 'confirm' : 'allow'
}

export interface PolicyAction {
  type: string
  url?: string
  keys?: string[]
  text?: string
}

export interface PolicyResult {
  verdict: Verdict
  reason?: string
}

/** Policy for one executor action. `ctx.windowTitle` is only needed for hotkey/type actions. */
export function checkAction(action: PolicyAction, ctx: KeyContext = {}): PolicyResult {
  switch (action.type) {
    case 'open_url':
    case 'navigate_url':
      try {
        assertSafeUrl(action.url)
        return { verdict: 'allow' }
      } catch (e) {
        return { verdict: 'deny', reason: (e as Error).message }
      }
    case 'hotkey': {
      const verdict = classifyHotkey(action.keys ?? [], ctx)
      return {
        verdict,
        reason: verdict === 'allow' ? undefined : `hotkey ${normalizeCombo(action.keys ?? [])}`
      }
    }
    case 'type': {
      const verdict = classifyType(ctx)
      return {
        verdict,
        reason: verdict === 'allow' ? undefined : `typing into "${ctx.windowTitle}"`
      }
    }
    default:
      return { verdict: 'allow' }
  }
}

/** True when checking this action needs the foreground window title. */
export function needsWindowContext(action: PolicyAction): boolean {
  return action.type === 'type' || action.type === 'hotkey'
}
