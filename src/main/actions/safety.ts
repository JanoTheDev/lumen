// Central policy for anything Lumen does outside its own windows (safety-policy.md).
// evaluate(action, ctx) rates every action an origin (the user's request, the agent, a lesson,
// a routine, an MCP tool) wants to run; nothing the model says changes the rules. The older
// helpers (assertSafeUrl, classifyHotkey) stay for Lumen's own UI and the a11y voice commands.
import { domainToUnicode } from 'url'
import type { InputStep } from '@shared/types'
import { findSecrets, hasCardNumber, maskSecrets } from './redact'
import {
  checkoutName,
  isNoSendFieldName,
  isPaymentFieldName,
  isPersonalFieldName,
  isRecipientName,
  isSendName,
  mailRiskyName,
  riskyName
} from './risk-names'

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

// ---- evaluate(action, ctx) ----

export type Risk = 'low' | 'medium' | 'high' | 'blocked'
/** claude-code: a permission prompt from a Claude Code session Lumen drives (08 T35). */
export type Origin =
  | 'user-direct'
  | 'agent'
  | 'lesson'
  | 'routine'
  | 'mcp'
  | 'claude-code'
  /** A buddy's run (08 T50): rated like an agent. */
  | 'buddy'
/** config.agent.confirm: which risks wait for the user. High always waits. */
export type ConfirmMode = 'always' | 'risky' | 'never'

export interface WindowInfo {
  title?: string
  /** Executable name, e.g. "OUTLOOK.EXE". */
  process?: string
  /** UIA class name of the focused element. */
  className?: string
  /** Win32 class of the foreground window (ConsoleWindowClass, CASCADIA_HOSTING_WINDOW_CLASS). */
  windowClass?: string
  /** The focused element is a password field (UIA IsPassword). */
  isPassword?: boolean
  /** false: the agent could not read the focused element (password / terminal unknown). */
  focusKnown?: boolean
  /** UIA name and role of the focused element. */
  focusName?: string
  focusRole?: string
}

export interface GrantLookup {
  has(scope: string): boolean
}

/** Per-task memory: sites and apps this task already used (first use is medium). */
export interface TaskState {
  visitedHosts: Set<string>
  appsUsed: Set<string>
}

export interface PolicyCtx {
  origin: Origin
  activeWindow?: WindowInfo
  grants?: GrantLookup
  taskId?: string
  /** The user's own words for this task (spoken or typed). */
  userText?: string
  /** Text the agent read (screen, page, file, tool result): the injection check's input. */
  observedText?: string
  task?: TaskState
  /** Type of the previous action in this batch ("type" makes Enter a submit). */
  prevType?: string
  /** Default: user-direct and lesson "never" (their own batch confirm), others "risky". */
  confirmMode?: ConfirmMode
  /** `agent.allowSendWithoutReview`: sending a message is medium (countdown), not high. */
  allowSendWithoutReview?: boolean
}

/** The fields evaluate reads; model Actions, input steps, launch_app and MCP calls fit. */
export interface EvalAction {
  type: string
  url?: string
  keys?: string[] | string
  text?: string
  value?: string
  description?: string
  target?: { kind?: string; text?: string }
  steps?: InputStep[]
  /** uia_act pattern (invoke, toggle, set_value, ...). */
  action?: string
  /** Name of the resolved target element. */
  elementName?: string
  /** uia_act: the target element is a password field (UIA IsPassword). */
  password?: boolean
  /** Why the model wants this (the injection check reads it). */
  rationale?: string
  /** launch_app: known-app registry id. */
  appId?: string
  /** mcp_tool */
  server?: string
  tool?: string
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean }
  /** mcp_tool arguments (shown redacted on the confirm card, summarized in the audit line). */
  args?: Record<string, unknown>
}

export interface Decision {
  risk: Risk
  reason: string
  needsConfirm: boolean
  /** Masked secrets found in typed text (shown in the confirm). */
  redactions?: string[]
  /** "app:<process>" | "mcp:<server>/<tool>" | "domain:<site>" | "scheme:mailto" (medium only). */
  grantScope?: string
  /** The agent books, buys or pays ("Book now"): the gate adds the price on the page now. */
  checkout?: string
}

interface Finding {
  risk: Risk
  reason: string
  /** A grant for this scope removes this finding's confirm (medium only). */
  scope?: string
  /** A book / pay / order button (Decision.checkout). */
  checkout?: string
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, blocked: 3 }

export const FROM_PAGE = 'This came from the page, not from you.'

function agentish(origin: Origin): boolean {
  return (
    origin === 'agent' ||
    origin === 'routine' ||
    origin === 'mcp' ||
    origin === 'claude-code' ||
    origin === 'buddy'
  )
}

function lower(s: string | undefined): string {
  return (s ?? '').toLowerCase()
}

// ---- windows ----

const TERMINAL_PROCESSES = new Set([
  'cmd.exe',
  'powershell.exe',
  'powershell_ise.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'wt.exe',
  'conhost.exe',
  'openconsole.exe',
  'bash.exe',
  'wsl.exe',
  'mintty.exe'
])
const TERMINAL_CLASSES =
  /^(consolewindowclass|cascadia_hosting_window_class|termcontrol|xterm-helper-textarea)$/i

/** Editors and IDEs with an integrated terminal (VS Code, its forks, JetBrains, Visual Studio). */
const IDE_PROCESSES = new Set([
  'code.exe',
  'code - insiders.exe',
  'vscodium.exe',
  'cursor.exe',
  'windsurf.exe',
  'zed.exe',
  'devenv.exe',
  'idea64.exe',
  'idea.exe',
  'pycharm64.exe',
  'webstorm64.exe',
  'phpstorm64.exe',
  'rider64.exe',
  'clion64.exe',
  'goland64.exe',
  'rubymine64.exe',
  'datagrip64.exe',
  'studio64.exe',
  'fleet.exe'
])
/** VS Code's terminal textarea is named "Terminal 1, pwsh …"; JetBrains' tool window "Terminal". */
const TERMINAL_FOCUS_NAME_RE = /^terminal\b|\bterminal \d/i

export function isIde(w: WindowInfo | undefined): boolean {
  return IDE_PROCESSES.has(lower(w?.process))
}

/** cmd, PowerShell, Windows Terminal, the Run box or an IDE's integrated terminal has the focus. */
export function isTerminal(w: WindowInfo | undefined): boolean {
  if (!w) return false
  if (TERMINAL_PROCESSES.has(lower(w.process))) return true
  if (w.className && TERMINAL_CLASSES.test(w.className)) return true
  if (w.windowClass && TERMINAL_CLASSES.test(w.windowClass)) return true
  if (isIde(w) && TERMINAL_FOCUS_NAME_RE.test(w.focusName ?? '')) return true
  return isShellWindow(w.title)
}

/** An IDE has the focus but which pane (editor or terminal) cannot be told. */
function ideFocusUnclear(w: WindowInfo | undefined): boolean {
  return isIde(w) && !isTerminal(w) && !w?.className && (w?.focusKnown !== true || !w.focusName)
}

const MESSAGING_PROCESSES = new Set([
  'outlook.exe',
  'olk.exe',
  'thunderbird.exe',
  'mailspring.exe',
  'slack.exe',
  'discord.exe',
  'teams.exe',
  'ms-teams.exe',
  'whatsapp.exe',
  'telegram.exe',
  'signal.exe'
])
const MESSAGING_TITLE_RE =
  /\b(gmail|outlook|inbox|slack|discord|microsoft teams|whatsapp|telegram|messenger|signal|linkedin|compose|new message)\b/i

/** Mail, chat or social app: Ctrl+Enter, or Enter after typing, sends there. */
export function isMessaging(w: WindowInfo | undefined): boolean {
  if (!w) return false
  return MESSAGING_PROCESSES.has(lower(w.process)) || MESSAGING_TITLE_RE.test(w.title ?? '')
}

const MAIL_PROCESSES = new Set(['outlook.exe', 'olk.exe', 'thunderbird.exe', 'mailspring.exe'])
const MAIL_TITLE_RE = /\b(gmail|outlook|inbox|compose|new message|untitled message)\b/i

/** An email app or webmail tab: Gmail, new or classic Outlook, Outlook on the web, Thunderbird. */
export function isMail(w: WindowInfo | undefined): boolean {
  if (!w) return false
  return MAIL_PROCESSES.has(lower(w.process)) || MAIL_TITLE_RE.test(w.title ?? '')
}

/** To / Cc / Bcc boxes: Gmail "To recipients", Outlook "To", "Cc", "Bcc" (and nl/de/fr/es). */
export function isRecipientField(name: string | undefined): boolean {
  return isRecipientName(name)
}

/** The focused element takes text (an edit box or a document), so a key edits rather than acts. */
function focusTakesText(w: WindowInfo | undefined): boolean {
  if (!w) return false
  if (/^(edit|document|combobox|text)$/i.test(w.focusRole ?? '')) return true
  return /edit|textarea|richedit/i.test(w.className ?? '')
}

function focusIsButton(w: WindowInfo | undefined): boolean {
  return /button|menuitem|hyperlink|^link$/i.test(w?.focusRole ?? '')
}

/** Message-list keys that delete, or report spam (Gmail "#" and "!", Outlook Del / Ctrl+D, and
 * Ctrl+Del: Ignore conversation, which deletes the thread and every later message in it). */
const MAIL_DELETE_COMBOS = new Set(['del', 'shift+del', 'ctrl+d', 'ctrl+del', '#', 'shift+3'])
const MAIL_SPAM_COMBOS = new Set(['!', 'shift+1'])
/** Classic Outlook sends with Alt+S (Ctrl+Enter is caught for every messaging app). */
const MAIL_SEND_COMBOS = new Set(['alt+s'])

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu

/** `word` appears in `said` as a whole word or address, not inside another one. */
function saidWhole(word: string, said: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}._%+@-])${esc}(?=$|[^\\p{L}\\p{N}_%+@-]|\\.(?:$|\\s))`,
    'iu'
  ).test(said)
}

/**
 * The user's own words name this recipient text: every address in it was said in full, or
 * every name word was said as a whole word ("Anna", "Anna Berg"). A prefix the agent typed for
 * autocomplete ("j", "ann") or a name word the user never said is not named.
 */
export function userNamed(text: string, userText: string | undefined): boolean {
  const t = text.trim().toLowerCase()
  if (!t || !userText) return false
  const said = userText.toLowerCase()
  const parts = t.split(/[;,]\s*/).filter((p) => p.trim())
  if (!parts.length) return false
  return parts.every((part) => {
    const addresses = part.match(EMAIL_RE) ?? []
    if (addresses.length && addresses.every((a) => saidWhole(a, said))) return true
    const words = part
      .replace(EMAIL_RE, ' ')
      .split(/[^\p{L}\p{N}'-]+/u)
      .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
      .filter(Boolean)
    if (!words.length || words.join('').length < 3) return false
    return words.every((w) => saidWhole(w, said))
  })
}

function isExplorer(w: WindowInfo | undefined): boolean {
  return lower(w?.process) === 'explorer.exe' || /\bfile explorer\b/i.test(w?.title ?? '')
}

function hasUnsavedMarker(title: string | undefined): boolean {
  return !!title && /^\*|\*$|\*\s+-|●|\bunsaved\b|\bnot saved\b/i.test(title.trim())
}

function isOwnWindow(title: string | undefined): boolean {
  return !!title && /\blumen\b/i.test(title)
}

// ---- URLs ----

const MS_SETTINGS_RE = /^ms-settings:[a-z0-9-]+(?:[?#][a-z0-9=&_-]*)?$/i
/** Settings pages where a wrong click weakens the machine. */
const SENSITIVE_SETTINGS_RE =
  /^ms-settings:(privacy|security|windowsdefender|accounts|yourinfo|emailandaccounts|signinoptions|otherusers|workplace|family-group|sync|network|wifi|ethernet|vpn|proxy|airplanemode|windowsupdate|recovery|backup|developers|activation|defaultapps)/i

/** IPv4 inside an IPv6 literal (::ffff:7f00:1, ::7f00:1, 64:ff9b::7f00:1) as a dotted quad. */
function embeddedV4(h: string): string | null {
  const m = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (!m) return null
  const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)]
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

function isPrivateHost(host: string): boolean {
  // "localhost." and "[::ffff:127.0.0.1]" are the same machine.
  const bare = host
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '')
  const h = embeddedV4(bare) ?? bare
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe[89ab])/.test(h)
  return false
}

/** Multi-label public suffixes beyond the ccTLD heuristic below (shared hosting included). */
const MULTI_PART_SUFFIXES = new Set([
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'com.cn',
  'com.tr',
  'co.in',
  'co.za',
  'com.mx',
  'github.io',
  'gitlab.io',
  'herokuapp.com',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'blogspot.com',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com'
])
/** Second-level labels that ccTLD registries hand out as suffixes (co.uk, gov.uk, ac.kr ...). */
const CC_SECOND_LEVEL = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gob',
  'go',
  'gov',
  'ltd',
  'mil',
  'ne',
  'net',
  'nic',
  'or',
  'org',
  'plc',
  'sch'
])

function isPublicSuffix(sld: string, tld: string): boolean {
  if (MULTI_PART_SUFFIXES.has(`${sld}.${tld}`)) return true
  return tld.length === 2 && CC_SECOND_LEVEL.has(sld)
}

/**
 * The registrable domain: "mail.google.com" → "google.com", "mail.example.co.uk" →
 * "example.co.uk". Sites, not hosts, count as visited and key "always for this site" grants.
 * IP addresses and single-label hosts are kept whole.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h.includes(':') || h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) return h
  const parts = h.replace(/^www\./, '').split('.')
  const n = parts.length
  if (n > 2 && isPublicSuffix(parts[n - 2], parts[n - 1])) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

function mentions(text: string | undefined, host: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  const site = siteOf(host)
  if (t.includes(host.toLowerCase()) || t.includes(site)) return true
  // "open youtube" names youtube.com; very short names ("x") only count with the domain.
  const label = site.split('.')[0]
  return label.length >= 3 && new RegExp(`\\b${label.replace(/[^a-z0-9]/g, '\\$&')}\\b`).test(t)
}

function urlFindings(raw: unknown, ctx: PolicyCtx, out: Finding[]): void {
  const block = (reason: string): void => void out.push({ risk: 'blocked', reason })
  if (typeof raw !== 'string' || !raw.trim()) return block('no URL')
  const trimmed = raw.trim()
  if (trimmed.length > 4096) return block('URL too long')
  if (trimmed.includes('\\')) return block(`blocked path-like URL: ${trimmed}`)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return block(`invalid URL: ${trimmed}`)
  }
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      break
    case 'mailto:':
      out.push({ risk: 'medium', reason: 'opens an email draft', scope: 'scheme:mailto' })
      return
    case 'ms-settings:':
      if (!MS_SETTINGS_RE.test(trimmed)) return block(`invalid settings link: ${trimmed}`)
      out.push(
        SENSITIVE_SETTINGS_RE.test(trimmed)
          ? { risk: 'high', reason: `opens sensitive Windows settings (${trimmed.slice(12)})` }
          : { risk: 'low', reason: 'opens Windows settings' }
      )
      return
    default:
      return block(`blocked URL scheme: ${url.protocol}`)
  }
  if (url.username || url.password) return block('blocked URL with credentials')
  const host = url.hostname
  if (!host) return block('URL has no host')
  const shown = domainToUnicode(host) || host
  if (isPrivateHost(host) && !(ctx.origin === 'user-direct' && mentions(ctx.userText, host)))
    return block(`blocked local network address: ${shown}`)
  if (!agentish(ctx.origin)) return
  const visited = !!ctx.task?.visitedHosts.has(siteOf(host))
  if (!visited && mentions(ctx.observedText, host) && !mentions(ctx.userText, host)) {
    out.push({ risk: 'high', reason: `${FROM_PAGE} Opens ${shown}` })
    return
  }
  if (ctx.task && !visited)
    out.push({
      risk: 'medium',
      reason: `goes to a new site: ${shown}`,
      scope: `domain:${siteOf(host)}`
    })
}

/** For the launcher: http(s), a mailto: draft or a plain ms-settings: page, else SafetyError. */
export function assertLaunchableUrl(raw: unknown): string {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (MS_SETTINGS_RE.test(t)) return t
    if (/^mailto:[^\s\\]{1,2000}$/i.test(t)) return new URL(t).toString()
  }
  return assertSafeUrl(raw)
}

// ---- keys ----

/** Blocked unless the user dictated exactly this combo (safety-policy §2). */
const DENY_COMBOS = new Set(['win+r', 'win+x', 'win+l', 'ctrl+alt+del', 'ctrl+shift+esc'])

/** Every key of the combo appears in what the user said ("press windows r"). */
export function dictatedCombo(combo: string, userText: string | undefined): boolean {
  if (!userText) return false
  const words = new Set(
    userText
      .toLowerCase()
      .split(/[\s+,.!?-]+/)
      .filter(Boolean)
      .map((w) => KEY_ALIASES[w] ?? w)
  )
  return combo.split('+').every((k) => words.has(k))
}

/** Keys that leave a field without putting anything in it (Enter is rated as a submit). */
const LEAVE_FIELD_COMBOS = new Set(['tab', 'shift+tab', 'esc', 'enter'])

/**
 * A key press, paste or copy while a payment field has the focus: blocked for agents like typing
 * there, so a card number cannot go in one digit (or one Ctrl+V) at a time.
 */
function paymentKeyFindings(combo: string, ctx: PolicyCtx, out: Finding[]): boolean {
  if (!agentish(ctx.origin) || LEAVE_FIELD_COMBOS.has(combo)) return false
  if (!isPaymentFieldName(ctx.activeWindow?.focusName)) return false
  out.push({ risk: 'blocked', reason: 'never presses keys in a payment field (you type those)' })
  return true
}

function keyFindings(keys: string[] | string, ctx: PolicyCtx, out: Finding[]): void {
  const combo = normalizeCombo(keys)
  if (!combo) return
  const parts = combo.split('+')
  const w = ctx.activeWindow
  if (paymentKeyFindings(combo, ctx, out)) return
  if (DENY_COMBOS.has(combo) || /^win\+\d$/.test(combo)) {
    const asked =
      ctx.origin === 'user-direct' &&
      (dictatedCombo(combo, ctx.userText) ||
        (combo === 'win+l' && /\block\b/i.test(ctx.userText ?? '')))
    out.push(
      asked
        ? { risk: 'medium', reason: `you asked for ${combo}` }
        : { risk: 'blocked', reason: `${combo} is blocked` }
    )
    return
  }
  if (combo === 'alt+f4') {
    out.push(
      isOwnWindow(w?.title)
        ? { risk: 'low', reason: 'closes a Lumen window' }
        : { risk: 'high', reason: `closes ${w?.title ? `“${w.title}”` : 'the window'}` }
    )
    return
  }
  if (parts.includes('win')) {
    out.push({ risk: 'medium', reason: `Windows shortcut ${combo}` })
    return
  }
  if (combo === 'ctrl+w' || combo === 'ctrl+shift+w' || combo === 'ctrl+f4') {
    out.push(
      hasUnsavedMarker(w?.title)
        ? { risk: 'high', reason: 'closes a window with unsaved changes' }
        : { risk: 'medium', reason: 'closes the tab or window' }
    )
    return
  }
  if ((combo === 'del' || combo === 'shift+del') && isExplorer(w)) {
    out.push({ risk: 'high', reason: 'deletes files' })
    return
  }
  const sendRisk: Risk = ctx.allowSendWithoutReview ? 'medium' : 'high'
  // Enter or Space on a focused Send / Delete / Pay button presses it (list rows are left out:
  // their names hold arbitrary subject text).
  const pressed = (combo === 'enter' || combo === 'space') && focusIsButton(w)
  const buys = pressed && agentish(ctx.origin) ? checkoutName(w?.focusName) : null
  if (buys) {
    out.push(checkoutFinding(buys))
    return
  }
  const focusWord = pressed
    ? (riskyName(w?.focusName) ?? (isMail(w) ? mailRiskyName(w?.focusName) : null))
    : null
  if (focusWord) {
    const send = isSendName(focusWord)
    out.push({ risk: send ? sendRisk : 'high', reason: `presses “${focusWord}”` })
    return
  }
  if (isMail(w) && agentish(ctx.origin) && isRecipientField(w?.focusName)) {
    // Enter / Tab in To picks the autocomplete suggestion; a paste adds whatever is on the
    // clipboard. Either way the recipient is not the text the policy rated.
    if (combo === 'ctrl+v' || combo === 'shift+insert') {
      out.push({ risk: 'high', reason: 'pastes into the recipient field' })
      return
    }
    if (combo === 'enter' || combo === 'tab') {
      out.push({ risk: 'medium', reason: 'picks the suggested recipient' })
      return
    }
  }
  if (isMail(w)) {
    if (MAIL_SEND_COMBOS.has(combo)) {
      out.push({ risk: sendRisk, reason: 'sends the email' })
      return
    }
    if (!focusTakesText(w) && MAIL_DELETE_COMBOS.has(combo)) {
      out.push({ risk: 'high', reason: 'deletes the email' })
      return
    }
    if (!focusTakesText(w) && MAIL_SPAM_COMBOS.has(combo)) {
      out.push({ risk: 'high', reason: 'reports the email as spam' })
      return
    }
  }
  const afterType = ctx.prevType === 'type'
  // Enter in a To, Subject or search box picks a suggestion or searches; it does not send.
  const fieldEnter = combo === 'enter' && isNoSendFieldName(w?.focusName)
  if (
    isMessaging(w) &&
    (combo === 'ctrl+enter' || (combo === 'enter' && afterType && !fieldEnter))
  ) {
    out.push({ risk: ctx.allowSendWithoutReview ? 'medium' : 'high', reason: 'sends the message' })
    return
  }
  if (combo === 'enter' && afterType && isTerminal(w))
    out.push({ risk: 'high', reason: 'runs the typed command' })
  else if (combo === 'enter' && afterType && agentish(ctx.origin) && ideFocusUnclear(w))
    out.push({ risk: 'high', reason: 'may run the typed text in the editor’s terminal' })
}

// ---- typing ----

function typeFindings(
  text: string,
  ctx: PolicyCtx,
  out: Finding[],
  redactions: string[],
  password = false,
  fieldName?: string
): void {
  const w = ctx.activeWindow
  if (w?.isPassword || password) {
    out.push(
      ctx.origin === 'user-direct'
        ? { risk: 'high', reason: 'types into a password field' }
        : { risk: 'blocked', reason: 'never types into password fields' }
    )
    return
  }
  if (isTerminal(w)) {
    out.push(
      agentish(ctx.origin)
        ? { risk: 'blocked', reason: 'never types into a terminal or the Run box' }
        : { risk: 'high', reason: `types into a terminal: “${maskSecrets(text)}”` }
    )
    return
  }
  if (agentish(ctx.origin)) {
    // Fail closed when the focused element cannot be read: it may be a password field or an
    // IDE's terminal.
    if (ideFocusUnclear(w)) {
      out.push({ risk: 'high', reason: 'may type into the editor’s terminal' })
      return
    }
    const field = fieldName ?? w?.focusName
    if (paymentFindings(text, field, out)) return
    if (w?.focusKnown === false)
      out.push({ risk: 'medium', reason: 'cannot tell which field has the focus' })
    if (isMail(w)) mailTypeFindings(text, field, ctx, out)
    if (!(isMail(w) && isRecipientField(field))) personalFindings(text, field, ctx, out)
  }
  const secrets = findSecrets(text)
  if (secrets.length) {
    const masked = secrets.map((s) => s.masked)
    redactions.push(...masked)
    out.push({ risk: 'medium', reason: `types a secret (${masked.join(', ')})` })
  }
  if (text.length > 200) out.push({ risk: 'medium', reason: `types ${text.length} characters` })
}

/**
 * Agent typing in an email app: a recipient always shows on the confirm card (high when the user
 * never said it, so a guessed address cannot slip in), and a lone "#" or "!" typed into the
 * message list is Gmail's delete / spam shortcut.
 */
function mailTypeFindings(
  text: string,
  field: string | undefined,
  ctx: PolicyCtx,
  out: Finding[]
): void {
  const shown = text.trim().slice(0, 120)
  if (isRecipientField(field)) {
    out.push(
      userNamed(text, ctx.userText)
        ? { risk: 'medium', reason: `fills the recipient “${shown}”` }
        : { risk: 'high', reason: `fills a recipient you did not name: “${shown}”` }
    )
    return
  }
  const w = ctx.activeWindow
  if (focusTakesText(w)) return
  const t = text.trim()
  // The focus is on the message list (a row, not a text box): each typed key is a shortcut
  // there (Gmail: x selects, # deletes, ! reports spam, e archives).
  const onList = !!w?.focusRole
  if (t === '#' || t === '!' || (onList && /[#!]/.test(t)))
    out.push({
      risk: 'high',
      reason: t.includes('#') ? 'deletes the email' : 'reports the email as spam'
    })
  else if (onList && t)
    out.push({ risk: 'medium', reason: 'types into the message list, keys act as shortcuts' })
}

// ---- checkout (05 T41) ----

function checkoutFinding(word: string): Finding {
  return { risk: 'high', reason: `books or pays: “${word}”`, checkout: word }
}

/**
 * Card numbers, CVCs and IBANs are the user's to type: an agent never types into a payment
 * field, and never types a number that passes the card check (Luhn) anywhere.
 */
function paymentFindings(text: string, field: string | undefined, out: Finding[]): boolean {
  if (isPaymentFieldName(field)) {
    out.push({ risk: 'blocked', reason: 'never types into a payment field (you type those)' })
    return true
  }
  if (hasCardNumber(text)) {
    out.push({ risk: 'blocked', reason: 'never types a card number (you type those)' })
    return true
  }
  return false
}

/** The whole typed text is one email address, or one phone number (not a date). */
const EMAIL_ONLY_RE = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u
const PHONE_ONLY_RE = /^\+?\(?\d[\d\s()./-]{5,}\d$/
const DATE_RE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/

function looksLikePhone(t: string): boolean {
  const digits = t.replace(/\D/g, '').length
  return PHONE_ONLY_RE.test(t) && !DATE_RE.test(t) && digits >= 7 && digits <= 15
}

/** The user said these digits (a phone number said with or without spaces). */
function saidDigits(text: string, userText: string | undefined): boolean {
  const d = text.replace(/\D/g, '')
  return !!d && (userText ?? '').replace(/\D/g, '').includes(d)
}

/**
 * Personal details (name, email, phone, address) an agent types into a form come from the
 * user's own words; anything else (a memory profile fact, a page's suggestion) is high and
 * shows the value on the card.
 */
function personalFindings(
  text: string,
  field: string | undefined,
  ctx: PolicyCtx,
  out: Finding[]
): void {
  const t = text.trim()
  if (!t) return
  const phone = looksLikePhone(t)
  if (!phone && !EMAIL_ONLY_RE.test(t) && !isPersonalFieldName(field)) return
  if (phone ? saidDigits(t, ctx.userText) : userNamed(t, ctx.userText)) return
  out.push({
    risk: 'high',
    reason: `fills in personal details you did not give: “${t.slice(0, 120)}”`
  })
}

// ---- clicks ----

function nameOf(a: EvalAction): string {
  return [a.elementName, a.text, a.description, a.target?.text].filter(Boolean).join(' ')
}

const SPOT_KINDS = new Set(['mark', 'point', 'rect'])
const RUNNABLE_RE = /\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|msi|msix|appx|scr|lnk|hta|reg)$/i

interface ClickHow {
  double?: boolean
  /** A coordinate target (mark, point, rect, raw input): the name is all the policy can rate. */
  spot?: boolean
}

function clickFindings(name: string, ctx: PolicyCtx, out: Finding[], how: ClickHow = {}): void {
  const { double = false, spot = false } = how
  // An agent task clicked a mark / point with nothing named under it: not rated by name.
  if (!name.trim()) {
    if (spot && agentish(ctx.origin) && ctx.task)
      out.push({ risk: 'medium', reason: 'clicks something without a readable name' })
    return
  }
  if (double && isExplorer(ctx.activeWindow) && RUNNABLE_RE.test(name.trim()))
    out.push({ risk: 'high', reason: `opens “${name.trim()}” (runs a program)` })
  const buys = agentish(ctx.origin) ? checkoutName(name) : null
  if (buys) return void out.push(checkoutFinding(buys))
  const mailWord = isMail(ctx.activeWindow) ? mailRiskyName(name) : null
  const word = riskyName(name) ?? mailWord
  if (!word) return recipientPickFindings(name, ctx, out)
  const send = ctx.allowSendWithoutReview && isSendName(word)
  out.push({ risk: send ? 'medium' : 'high', reason: `clicks “${word}”` })
}

/** Compose fields an agent clicks while the focus is still in To (not a suggestion). */
const COMPOSE_FIELD_RE =
  /(?:^|[^\p{L}])(message|body|bericht|nachricht|corps|cuerpo|mensaje|attach|bijlage|anhang|pièce jointe|adjuntar)(?=$|[^\p{L}])/iu

/**
 * Agent click in an email app on an autocomplete suggestion: a row with an address, or anything
 * picked while the focus is in a To / Cc / Bcc box. Rated as entering that recipient: high
 * unless the user said the address or the whole name.
 */
function recipientPickFindings(name: string, ctx: PolicyCtx, out: Finding[]): void {
  const w = ctx.activeWindow
  if (!agentish(ctx.origin) || !isMail(w)) return
  const shown = name.trim().slice(0, 120)
  const hasAddress = new RegExp(EMAIL_RE.source, 'u').test(name)
  const inTo =
    isRecipientField(w?.focusName) && !isNoSendFieldName(name) && !COMPOSE_FIELD_RE.test(name)
  if (!hasAddress && !inTo) return
  out.push(
    userNamed(name, ctx.userText)
      ? { risk: 'medium', reason: `picks the recipient “${shown}”` }
      : { risk: 'high', reason: `picks a recipient you did not name: “${shown}”` }
  )
}

// ---- MCP ----

const WRITE_VERBS = new Set(
  'write delete remove send create update post put patch set insert drop move rename publish upload edit modify execute run add trash archive'.split(
    ' '
  )
)

function mcpFindings(a: EvalAction, out: Finding[]): void {
  const name = `${a.server ?? '?'}/${a.tool ?? '?'}`
  const words = (a.tool ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
  if (a.annotations?.destructiveHint)
    out.push({ risk: 'high', reason: `${name} changes or deletes data` })
  else if (!a.annotations?.readOnlyHint && words.some((w) => WRITE_VERBS.has(w)))
    out.push({ risk: 'high', reason: `${name} may change data` })
  else out.push({ risk: 'medium', reason: `uses ${name}`, scope: `mcp:${name}` })
}

// ---- classify ----

const LOW_TYPES = new Set(['scroll', 'move', 'focus_browser', 'wait', 'observe', 'read'])
const INPUT_TYPES = new Set([
  'click',
  'click_target',
  'click_bbox',
  'click_element',
  'click_nth_element',
  'type',
  'hotkey',
  'uia_act',
  'input'
])

const CITES_OBSERVED_RE =
  /\b(the (page|screen|site|website|email|mail|message|document|file|tool( result)?|result|popup|dialog) (says|said|asks|asked|tells|told|instructs|instructed|wants|requires|requests)|according to the (page|instructions|email|document|message)|as instructed by|instructions (on|in) the (page|screen|email|document))\b/i

function classify(a: EvalAction, ctx: PolicyCtx, out: Finding[], redactions: string[]): void {
  switch (a.type) {
    case 'open_url':
    case 'navigate_url':
      urlFindings(a.url, ctx, out)
      break
    case 'hotkey':
      keyFindings(a.keys ?? [], ctx, out)
      break
    case 'type':
      typeFindings(a.text ?? '', ctx, out, redactions)
      break
    case 'click':
    case 'click_target':
    case 'click_bbox':
    case 'click_element':
    case 'click_nth_element':
      clickFindings(nameOf(a), ctx, out, { spot: SPOT_KINDS.has(a.target?.kind ?? '') })
      break
    case 'uia_act':
      if (a.action === 'set_value')
        typeFindings(
          a.value ?? '',
          ctx,
          out,
          redactions,
          a.password,
          a.elementName ?? a.description
        )
      else if (a.action !== 'focus' && a.action !== 'scroll_into_view')
        clickFindings(nameOf(a), ctx, out)
      break
    case 'input': {
      let prevType = ctx.prevType
      for (const s of a.steps ?? []) {
        const stepCtx = { ...ctx, prevType }
        if (s.t === 'keys') keyFindings(s.combo, stepCtx, out)
        else if (s.t === 'type') typeFindings(s.text, stepCtx, out, redactions)
        else if (s.t === 'click')
          clickFindings(nameOf(a), ctx, out, { double: (s.count ?? 1) > 1, spot: true })
        if (s.t !== 'wait') prevType = s.t
      }
      break
    }
    case 'launch_app':
      out.push({
        risk: 'medium',
        reason: `opens ${a.appId ?? 'an app'}`,
        scope: `app:${appSlug(a.appId)}`
      })
      break
    case 'mcp_tool':
      mcpFindings(a, out)
      break
    case 'write_file':
      // create_file (docs-out): a new file in Documents/Lumen is low; elsewhere medium for
      // agents; replacing an existing file always asks.
      if (a.action === 'replace')
        out.push({ risk: 'high', reason: `replaces ${a.description ?? 'a file'}` })
      else if (a.action !== 'default' && agentish(ctx.origin))
        out.push({ risk: 'medium', reason: `saves ${a.description ?? 'a file'}` })
      break
    case 'move_file':
      // rename_file / move_file (files/granted): only inside folders the user granted, never
      // over another file, undo kept, so low (automations run them unattended).
      break
    default:
      if (!LOW_TYPES.has(a.type)) out.push({ risk: 'high', reason: `unknown action ${a.type}` })
  }
  if (!agentish(ctx.origin)) return
  // The first input into an app in agent mode is medium ("always for <app>" grants it).
  const proc = lower(ctx.activeWindow?.process)
  if (ctx.task && proc && INPUT_TYPES.has(a.type) && !ctx.task.appsUsed.has(proc))
    out.push({ risk: 'medium', reason: `first use of ${proc}`, scope: `app:${proc}` })
  // The model says the screen told it to: that is the page talking, not the user.
  if (a.rationale && CITES_OBSERVED_RE.test(a.rationale))
    out.push({ risk: 'high', reason: FROM_PAGE })
}

/** "Visual Studio Code" → "visual-studio-code": a grant scope has no spaces. */
export function appSlug(name: string | undefined): string {
  return (
    lower(name)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._-]/gu, '') || 'app'
  )
}

export function confirmNeeded(risk: Risk, mode: ConfirmMode, granted: boolean): boolean {
  if (risk === 'high') return true
  if (risk !== 'medium') return false
  if (mode === 'always') return true
  if (mode === 'never') return false
  return !granted
}

/** Rates one action. Blocked never runs; high always confirms and is never grantable. */
export function evaluate(action: EvalAction, ctx: PolicyCtx): Decision {
  const findings: Finding[] = []
  const redactions: string[] = []
  classify(action, ctx, findings, redactions)
  const top = findings.reduce<Risk>((r, f) => (RANK[f.risk] > RANK[r] ? f.risk : r), 'low')
  const atTop = findings.filter((f) => f.risk === top)
  const reason = atTop.map((f) => f.reason).join('; ') || action.type
  if (top === 'blocked') return { risk: top, reason, needsConfirm: false }
  const checkout = atTop.find((f) => f.checkout)?.checkout
  // Grantable only when every medium reason is covered by the same scope.
  const scopes = new Set(atTop.map((f) => f.scope))
  const grantScope = top === 'medium' && scopes.size === 1 ? [...scopes][0] : undefined
  const mode =
    ctx.confirmMode ?? (ctx.origin === 'user-direct' || ctx.origin === 'lesson' ? 'never' : 'risky')
  const granted = !!grantScope && !!ctx.grants?.has(grantScope)
  return {
    risk: top,
    reason,
    needsConfirm: confirmNeeded(top, mode, granted),
    ...(redactions.length ? { redactions } : {}),
    ...(grantScope ? { grantScope } : {}),
    ...(checkout ? { checkout } : {})
  }
}

/** After an action ran: its site and app count as used for the rest of the task. */
export function noteExecuted(action: EvalAction, ctx: PolicyCtx): void {
  if (!ctx.task) return
  const proc = lower(ctx.activeWindow?.process)
  if (proc && INPUT_TYPES.has(action.type)) ctx.task.appsUsed.add(proc)
  if ((action.type === 'open_url' || action.type === 'navigate_url') && action.url) {
    try {
      const host = new URL(action.url).hostname
      if (host) ctx.task.visitedHosts.add(siteOf(host))
    } catch {
      /* not a URL: nothing visited */
    }
  }
}

/** A copy with typed text and values masked (confirm card). */
export function maskedForConfirm<T extends EvalAction>(a: T): T {
  return {
    ...a,
    ...(a.text ? { text: maskSecrets(a.text) } : {}),
    ...(a.value ? { value: maskSecrets(a.value) } : {})
  }
}

export function newTaskState(): TaskState {
  return { visitedHosts: new Set(), appsUsed: new Set() }
}
