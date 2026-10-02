// A buddy clamped to least privilege (the same limits as model-written skills, skills/clamp):
// known background tools only, https origins only (no `*.com`), local folders only, sane
// budgets. Applied on every load, so a hand-edited buddy.md cannot widen past it. Pure.
import {
  BUDDY_DEFAULT_PER_RUN_USD,
  BUDDY_INSTRUCTIONS_MAX,
  BUDDY_NAME_MAX,
  type Buddy,
  type BuddyModel,
  type BuddyPermissions,
  type BuddyReport
} from '@shared/buddies'
import { websitePattern } from '../skills/clamp'

/**
 * Background tools a buddy may list. finish, ask_user, memory_write and notify are always
 * given; run_subagents follows `subagents`. request_foreground waits for 08 T52 (a foreground
 * run under the buddy's envelope).
 */
export const BUDDY_TOOL_NAMES = [
  'fetch_url',
  'read_file',
  'read_document',
  'create_file',
  'rename_file',
  'move_file',
  'lookup_howto',
  'memory_search',
  'present_cards',
  'spawn_task'
] as const
export const BUDDY_BASE_TOOLS = ['finish', 'ask_user', 'memory_write', 'notify'] as const

const MODELS: readonly BuddyModel[] = ['fast', 'main', 'planning']
const REPORTS: readonly BuddyReport[] = ['notify', 'spoken', 'silent', 'cards']
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONNECTOR_RE = /^[a-z0-9-]{1,40}$/
const SCHEDULE_RE = /^[A-Za-z0-9_-]{1,64}$/
const COLOR_RE = /^#[0-9a-f]{6}$/i
const PALETTE = ['#5b8def', '#e0705a', '#4fb286', '#c47fd5', '#e3a33b', '#3fb3c4', '#d8648f']
const MAX_LIST = 10

/** A safe buddy id: lowercase letters, digits and inner dashes, ≤ 40 chars. */
export function isBuddyId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** "Inbox Buddy!" → "inbox-buddy"; a free id when it is taken ("inbox-buddy-2"). */
export function buddyIdFor(name: string, taken: (id: string) => boolean = () => false): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34)
      .replace(/-+$/, '') || 'buddy'
  if (!taken(base)) return base
  for (let n = 2; n < 1000; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now().toString(36)}`
}

/** First words of everyday commands: a buddy name never starts with one unless it ends in "Buddy". */
const COMMAND_VERBS = new Set([
  'open',
  'send',
  'search',
  'click',
  'close',
  'delete',
  'reply',
  'write',
  'call',
  'play',
  'stop',
  'show',
  'go',
  'find',
  'read',
  'make',
  'create'
])

/**
 * A name that starts like a command ("Send Email") gets " Buddy" at the end ("Send Email
 * Buddy"), so "send email to Bob" stays a request and the buddy is called by its full name.
 */
export function safeBuddyName(name: string): string {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const [first, last] = [words[0], words[words.length - 1]]
  if (!first || !COMMAND_VERBS.has(first) || last === 'buddy') return name
  return `${name.slice(0, BUDDY_NAME_MAX - 6).trimEnd()} Buddy`
}

/** A name as calls and the uniqueness check compare it: case, spacing and marks ignored. */
export function buddyNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** "Inbox Buddy" when free, else "Inbox Buddy 2" … (a command-like name ends in "Buddy"). */
export function freeBuddyName(name: string, taken: (name: string) => boolean): string {
  const base = safeBuddyName(
    name
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, BUDDY_NAME_MAX - 3) || 'My Buddy'
  )
  if (!taken(base)) return base
  for (let n = 2; n < 100; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`
  return `${base} ${Date.now().toString(36).slice(-2)}`
}

const oneLine = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const bool = (v: unknown, dflt = false): boolean => (typeof v === 'boolean' ? v : dflt)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const uniq = (list: string[], max = MAX_LIST): string[] => [...new Set(list)].slice(0, max)
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined

/** Top folders of a drive that hold Windows or programs, never a buddy's. */
const SYSTEM_TOPS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
  'documents and settings',
  '$recycle.bin',
  'system volume information',
  'recovery'
])
/** Folders anywhere in the path that hold app data, keys or Lumen's own files. */
const PRIVATE_PARTS = new Set(['appdata', '.ai-overlay', '.ssh', '.gnupg', '.aws', '.azure'])

/**
 * A local folder: drive-letter absolute, no `..`, not UNC or a device; not a drive root, a
 * system folder, the Users folder or a profile root, nor inside AppData or Lumen's data.
 */
export function folderAllowed(p: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(p) || p.length > 260) return false
  const parts = p
    .slice(3)
    .split(/[\\/]+/)
    .filter(Boolean)
  if (!parts.length) return false
  const bad = (x: string): boolean =>
    x === '..' || x === '.' || /[<>:"|?*]/.test(x) || [...x].some((c) => c.charCodeAt(0) < 32)
  if (parts.some(bad)) return false
  const low = parts.map((x) => x.toLowerCase().replace(/[. ]+$/, ''))
  if (low.some((x) => PRIVATE_PARTS.has(x))) return false
  // C:\Users\<name>\Documents is fine; C:\Users and C:\Users\<name> are not.
  if (low[0] === 'users' || low[0] === 'documents and settings') return low.length >= 3
  return !SYSTEM_TOPS.has(low[0])
}

function look(raw: unknown, id: string, name: string): Buddy['look'] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const color =
    typeof r.color === 'string' && COLOR_RE.test(r.color)
      ? r.color.toLowerCase()
      : PALETTE[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length]
  const emoji = typeof r.emoji === 'string' ? r.emoji.trim() : ''
  // One emoji (a few code points for joined ones), no letters or markup.
  if (emoji && [...emoji].length <= 8 && !/[\p{L}\p{N}<>&"'\s]/u.test(emoji))
    return { color, emoji }
  const initial = typeof r.initial === 'string' ? r.initial.trim() : ''
  const letter = /^\p{L}$/u.test(initial)
    ? initial
    : ([...name].find((c) => /\p{L}/u.test(c)) ?? 'B')
  return { color, initial: letter.toUpperCase() }
}

export interface ClampContext {
  /** Connector ids that exist (default: any well-formed id). */
  connectors?: readonly string[]
  /** Skill names that exist (default: any well-formed name). */
  skills?: readonly string[]
}

export function clampPermissions(raw: unknown, ctx: ClampContext = {}): BuddyPermissions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const files = (r.files && typeof r.files === 'object' ? r.files : {}) as Record<string, unknown>
  const input = bool(r.input)
  const known = new Set<string>(BUDDY_TOOL_NAMES)
  const network: string[] = []
  for (const w of strings(r.network)) {
    const p = websitePattern(w)
    if (p && !network.includes(p) && network.length < MAX_LIST) network.push(p)
  }
  const knownConnectors = ctx.connectors ? new Set(ctx.connectors) : null
  return {
    tools: uniq(strings(r.tools).filter((t) => known.has(t))),
    apps: input ? uniq(strings(r.apps).filter((a) => KEBAB_RE.test(a) && a.length <= 40)) : [],
    input,
    network,
    files: {
      read: uniq(strings(files.read).filter(folderAllowed)),
      write: uniq(strings(files.write).filter(folderAllowed))
    },
    connectors: uniq(
      strings(r.connectors).filter(
        (c) => CONNECTOR_RE.test(c) && (!knownConnectors || knownConnectors.has(c))
      )
    ),
    profile: bool(r.profile),
    risky: bool(r.risky),
    screen: bool(r.screen)
  }
}

/**
 * Any parsed buddy (buddy.md header, a model draft, an IPC payload) as a valid Buddy. `id` must
 * already be valid; `forceUntrusted` keeps an imported buddy untrusted whatever its file says.
 */
export function clampBuddy(
  id: string,
  raw: Record<string, unknown>,
  opts: ClampContext & { forceUntrusted?: boolean; now?: number } = {}
): Buddy {
  if (!isBuddyId(id)) throw new Error(`not a buddy id: ${id}`)
  const now = opts.now ?? Date.now()
  const name = safeBuddyName(oneLine(raw.name, BUDDY_NAME_MAX) || id)
  const b = (raw.budget && typeof raw.budget === 'object' ? raw.budget : {}) as Record<
    string,
    unknown
  >
  const perMonthUsd = num(b.perMonthUsd, 0.01, 1000)
  const perMonthTokens = num(b.perMonthTokens, 1000, 1e9)
  const knownSkills = opts.skills ? new Set(opts.skills) : null
  const instructions =
    typeof raw.instructions === 'string'
      ? raw.instructions.replace(/\r\n?/g, '\n').trim().slice(0, BUDDY_INSTRUCTIONS_MAX)
      : ''
  const createdAt = num(raw.createdAt, 0, 1e14) ?? now
  return {
    id,
    name,
    look: look(raw.look, id, name),
    instructions,
    permissions: clampPermissions(raw.permissions, opts),
    model: MODELS.includes(raw.model as BuddyModel) ? (raw.model as BuddyModel) : 'fast',
    budget: {
      perRunUsd: num(b.perRunUsd, 0.01, 5) ?? BUDDY_DEFAULT_PER_RUN_USD,
      ...(perMonthUsd !== undefined ? { perMonthUsd } : {}),
      ...(perMonthTokens !== undefined ? { perMonthTokens: Math.round(perMonthTokens) } : {})
    },
    skills: uniq(
      strings(raw.skills).filter(
        (s) => KEBAB_RE.test(s) && s.length <= 64 && (!knownSkills || knownSkills.has(s))
      ),
      20
    ),
    subagents: bool(raw.subagents),
    report: REPORTS.includes(raw.report as BuddyReport) ? (raw.report as BuddyReport) : 'notify',
    scheduleIds: uniq(
      strings(raw.scheduleIds).filter((s) => SCHEDULE_RE.test(s)),
      20
    ),
    trust: opts.forceUntrusted || raw.trust !== 'mine' ? 'community-untrusted' : 'mine',
    enabled: bool(raw.enabled, true),
    createdAt,
    updatedAt: num(raw.updatedAt, 0, 1e14) ?? createdAt
  }
}
