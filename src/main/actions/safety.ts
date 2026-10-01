// Central policy for anything Lumen does outside its own windows (safety-policy.md).
// evaluate(action, ctx) rates every action an origin (the user's request, the agent, a lesson,
// a routine, an MCP tool) wants to run; nothing the model says changes the rules. The older
// helpers (assertSafeUrl, classifyHotkey) stay for Lumen's own UI and the a11y voice commands.
import { domainToUnicode } from 'url'
import type { InputStep } from '@shared/types'
import { findSecrets, maskSecrets } from './redact'
import { riskyName } from './risk-names'

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
export type Origin = 'user-direct' | 'agent' | 'lesson' | 'routine' | 'mcp' | 'claude-code'
/** config.agent.confirm: which risks wait for the user. High always waits. */
export type ConfirmMode = 'always' | 'risky' | 'never'

export interface WindowInfo {
  title?: string
  /** Executable name, e.g. "OUTLOOK.EXE". */
  process?: string
  /** UIA class name of the focused element. */
  className?: string
  /** The focused element is a password field (UIA IsPassword). */
  isPassword?: boolean
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
  /** Why the model wants this (the injection check reads it). */
  rationale?: string
  /** launch_app: known-app registry id. */
  appId?: string
  /** mcp_tool */
  server?: string
  tool?: string
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean }
}

export interface Decision {
  risk: Risk
  reason: string
  needsConfirm: boolean
  /** Masked secrets found in typed text (shown in the confirm). */
  redactions?: string[]
  /** "app:<process>" | "mcp:<server>/<tool>" | "domain:<site>" | "scheme:mailto" (medium only). */
  grantScope?: string
}

interface Finding {
  risk: Risk
  reason: string
  /** A grant for this scope removes this finding's confirm (medium only). */
  scope?: string
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, blocked: 3 }

export const FROM_PAGE = 'This came from the page, not from you.'

function agentish(origin: Origin): boolean {
  return origin === 'agent' || origin === 'routine' || origin === 'mcp' || origin === 'claude-code'
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

/** cmd, PowerShell, Windows Terminal, the Run box or a VS Code terminal has the focus. */
export function isTerminal(w: WindowInfo | undefined): boolean {
  if (!w) return false
  if (TERMINAL_PROCESSES.has(lower(w.process))) return true
  if (w.className && TERMINAL_CLASSES.test(w.className)) return true
  return isShellWindow(w.title)
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

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
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

function keyFindings(keys: string[] | string, ctx: PolicyCtx, out: Finding[]): void {
  const combo = normalizeCombo(keys)
  if (!combo) return
  const parts = combo.split('+')
  const w = ctx.activeWindow
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
  const afterType = ctx.prevType === 'type'
  if (isMessaging(w) && (combo === 'ctrl+enter' || (combo === 'enter' && afterType))) {
    out.push({ risk: 'high', reason: 'sends the message' })
    return
  }
  if (combo === 'enter' && afterType && isTerminal(w))
    out.push({ risk: 'high', reason: 'runs the typed command' })
}

// ---- typing ----

function typeFindings(text: string, ctx: PolicyCtx, out: Finding[], redactions: string[]): void {
  const w = ctx.activeWindow
  if (w?.isPassword) {
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
  const secrets = findSecrets(text)
  if (secrets.length) {
    const masked = secrets.map((s) => s.masked)
    redactions.push(...masked)
    out.push({ risk: 'medium', reason: `types a secret (${masked.join(', ')})` })
  }
  if (text.length > 200) out.push({ risk: 'medium', reason: `types ${text.length} characters` })
}

// ---- clicks ----

function nameOf(a: EvalAction): string {
  return [a.elementName, a.text, a.description, a.target?.text].filter(Boolean).join(' ')
}

function clickFindings(name: string, out: Finding[]): void {
  const word = riskyName(name)
  if (word) out.push({ risk: 'high', reason: `clicks “${word}”` })
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
      clickFindings(nameOf(a), out)
      break
    case 'uia_act':
      if (a.action === 'set_value') typeFindings(a.value ?? '', ctx, out, redactions)
      else if (a.action !== 'focus' && a.action !== 'scroll_into_view')
        clickFindings(nameOf(a), out)
      break
    case 'input': {
      let prevType = ctx.prevType
      for (const s of a.steps ?? []) {
        const stepCtx = { ...ctx, prevType }
        if (s.t === 'keys') keyFindings(s.combo, stepCtx, out)
        else if (s.t === 'type') typeFindings(s.text, stepCtx, out, redactions)
        else if (s.t === 'click' && a.elementName) clickFindings(a.elementName, out)
        if (s.t !== 'wait') prevType = s.t
      }
      break
    }
    case 'launch_app':
      out.push({
        risk: 'medium',
        reason: `opens ${a.appId ?? 'an app'}`,
        scope: `app:${lower(a.appId)}`
      })
      break
    case 'mcp_tool':
      mcpFindings(a, out)
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
    ...(grantScope ? { grantScope } : {})
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
