// Plain words and small helpers for Home's Buddies strip and Settings → Buddies (08 T53): the
// avatar, state and next-run lines, permissions with the wider ones marked, run history and this
// month's cost. Pure, so it is tested without a window.
import type {
  BuddyBudget,
  BuddyDraft,
  BuddyLook,
  BuddyModel,
  BuddyPermissions,
  BuddyReport,
  BuddyRunSummary,
  BuddySchedule
} from '@shared/buddies'
import type { BuddyEditable, BuddyRow } from '@shared/buddy-views'
import type { UsageReport } from '@shared/usage'
import { isHex, pickOnColor } from '../../../theme/contrast'

/** The look picker's colours (the same set new buddies get). */
export const BUDDY_COLORS: readonly { value: string; label: string }[] = [
  { value: '#5b8def', label: 'Blue' },
  { value: '#e0705a', label: 'Coral' },
  { value: '#4fb286', label: 'Green' },
  { value: '#c47fd5', label: 'Purple' },
  { value: '#e3a33b', label: 'Amber' },
  { value: '#3fb3c4', label: 'Teal' },
  { value: '#d8648f', label: 'Pink' }
]

export const MODEL_OPTIONS: readonly { value: BuddyModel; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'main', label: 'Main' },
  { value: 'planning', label: 'Planning' }
]

export const REPORT_OPTIONS: readonly { value: BuddyReport; label: string }[] = [
  { value: 'notify', label: 'Show a notice' },
  { value: 'spoken', label: 'Say it when I’m here' },
  { value: 'silent', label: 'Quietly in the Tasks list' },
  { value: 'cards', label: 'Answer cards' }
]

/** Background tools a buddy may be given (main clamps to the same list). */
export const BUDDY_TOOLS: readonly { value: string; label: string; wide: boolean }[] = [
  { value: 'fetch_url', label: 'Read web pages', wide: false },
  { value: 'lookup_howto', label: 'Look up how-tos', wide: false },
  { value: 'read_file', label: 'Read shared files', wide: false },
  { value: 'read_document', label: 'Read documents in its folders', wide: false },
  { value: 'memory_search', label: 'Search your memory', wide: false },
  { value: 'present_cards', label: 'Show answer cards', wide: false },
  { value: 'create_file', label: 'Make files', wide: true },
  { value: 'rename_file', label: 'Rename files', wide: true },
  { value: 'move_file', label: 'Move files', wide: true },
  { value: 'spawn_task', label: 'Start helper tasks', wide: false }
]

const toolLabel = (t: string): string => BUDDY_TOOLS.find((x) => x.value === t)?.label ?? t

/** The avatar's one character: its emoji, else its letter. */
export function avatarText(look: BuddyLook, name = ''): string {
  return look.emoji || look.initial || [...name].find((c) => /\p{L}/u.test(c))?.toUpperCase() || 'B'
}

/** What the user typed in "Emoji or letter": one letter is an initial, anything else an emoji. */
export function lookFromText(text: string, color: string, name = ''): BuddyLook {
  const t = text.trim()
  if (/^\p{L}$/u.test(t)) return { color, initial: t.toUpperCase() }
  if (t && [...t].length <= 8 && !/[\p{L}\p{N}<>&"'\s]/u.test(t)) return { color, emoji: t }
  return { color, initial: avatarText({ color }, name) }
}

/** Black or white, whichever reads better on the avatar colour (WCAG contrast). */
export function inkOn(hex: string): '#000' | '#fff' {
  return isHex(hex) ? pickOnColor(hex) : '#fff'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "today at 08:00", "tomorrow at 08:00", "Mon 6 Oct at 08:00" (local time). */
export function whenText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / 86_400_000)
  const day =
    days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days === -1
          ? 'yesterday'
          : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
  return `${day} at ${clock(d)}`
}

export function nextRunLine(at: number | undefined, now = Date.now()): string {
  return at === undefined ? '' : `Next: ${whenText(at, now)}`
}

const PHASE_WORDS: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Working',
  asking: 'Has a question',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  skipped: 'Skipped'
}

export const phaseWord = (phase: string): string => PHASE_WORDS[phase] ?? phase

const shorten = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/** The strip and list status: working, off, else the last result. */
export function stateLine(b: BuddyRow): string {
  if (b.onScreen) return 'Working on screen'
  if (b.running) return 'Working…'
  if (!b.enabled) return 'Off'
  const last = b.lastRun
  if (!last) return 'No runs yet'
  if (last.summary && last.phase === 'done') return shorten(last.summary, 90)
  return phaseWord(last.phase)
}

/** One history row: "Done · today at 08:01 · $0.03". */
export function runLine(r: BuddyRunSummary, now = Date.now()): string {
  const parts = [phaseWord(r.phase), whenText(r.startedAt, now)]
  if (r.costUsd > 0) parts.push(money(r.costUsd))
  return parts.join(' · ')
}

export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '< $0.01'
  return `$${usd.toFixed(2)}`
}

export interface BuddyMonth {
  usd: number
  tokens: number
}

/** This month's spend of one buddy from the usage report's buddy table (zero when absent). */
export function monthSpend(report: UsageReport | null, id: string): BuddyMonth {
  const row = report?.tables.buddy.find((r) => r.key === id)
  return row ? { usd: row.sums.usd, tokens: row.sums.in + row.sums.out } : { usd: 0, tokens: 0 }
}

/** "$0.42 of $5.00 this month · 12,300 tokens". */
export function monthLine(m: BuddyMonth, budget: BuddyBudget): string {
  const usd =
    budget.perMonthUsd !== undefined
      ? `${money(m.usd)} of ${money(budget.perMonthUsd)} this month`
      : `${money(m.usd)} this month`
  const tokens =
    budget.perMonthTokens !== undefined
      ? `${m.tokens.toLocaleString('en-US')} of ${budget.perMonthTokens.toLocaleString('en-US')} tokens`
      : `${m.tokens.toLocaleString('en-US')} tokens`
  return `${usd} · ${tokens}`
}

export interface PermissionRow {
  key: string
  text: string
  /** It may do more than before (or, for a new buddy, more than read and answer). */
  wider: boolean
}

const listWider = (now: string[], before: string[] | undefined): boolean =>
  before ? now.some((x) => !before.includes(x)) : now.length > 0

/**
 * One line per thing the buddy may do. With `before` (the saved buddy), `wider` marks what
 * grew; without it (a new draft), what goes past reading and answering.
 */
export function permissionRows(p: BuddyPermissions, before?: BuddyPermissions): PermissionRow[] {
  const out: PermissionRow[] = []
  const flag = (now: boolean, was: boolean | undefined): boolean => now && (before ? !was : true)
  const tools = p.tools.filter((t) => BUDDY_TOOLS.some((x) => x.value === t))
  if (tools.length) {
    const wideNew = tools.some((t) => BUDDY_TOOLS.find((x) => x.value === t)?.wide)
    out.push({
      key: 'tools',
      text: `Tools: ${tools.map(toolLabel).join(', ')}`,
      wider: before ? listWider(tools, before.tools) : wideNew
    })
  }
  if (p.network.length)
    out.push({
      key: 'network',
      text: `Opens web pages: ${p.network.join(', ')}`,
      wider: listWider(p.network, before?.network)
    })
  if (p.files.read.length)
    out.push({
      key: 'read',
      text: `Reads files in ${p.files.read.join(', ')}`,
      wider: before ? listWider(p.files.read, before.files.read) : false
    })
  if (p.files.write.length)
    out.push({
      key: 'write',
      text: `Changes files in ${p.files.write.join(', ')}`,
      wider: listWider(p.files.write, before?.files.write)
    })
  if (p.connectors.length)
    out.push({
      key: 'connectors',
      text: `Uses connectors: ${p.connectors.join(', ')}`,
      wider: listWider(p.connectors, before?.connectors)
    })
  if (p.input)
    out.push({
      key: 'input',
      text: p.apps.length
        ? `Uses your mouse and keyboard in ${p.apps.join(', ')}`
        : 'Uses your mouse and keyboard in any app',
      wider: flag(true, before?.input) || (!!before && listWider(p.apps, before.apps))
    })
  if (p.screen)
    out.push({
      key: 'screen',
      text: 'May ask to work on your screen',
      wider: flag(true, before?.screen)
    })
  if (p.profile)
    out.push({
      key: 'profile',
      text: 'Reads your saved profile (name, address, email)',
      wider: flag(true, before?.profile)
    })
  if (!out.length)
    out.push({ key: 'none', text: 'Only reads what it is given and answers', wider: false })
  if (p.risky) out.push({ key: 'risky', text: 'Asks before every action', wider: false })
  return out
}

/** Text lists ("one per line or comma"): trimmed, no blanks, no repeats. */
export function parseList(text: string, max = 20): string[] {
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const t = part.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, max)
}

/** A route's buddy: `#/settings/buddies/<id>` → id, `_new` → make one, else null (the list). */
export function buddyFromHash(hash: string): string | null {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] !== 'settings' || parts[1] !== 'buddies') return null
  const sub = parts[2] ?? ''
  return /^(_new|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/.test(sub) ? sub : null
}

export const editableOf = (b: BuddyEditable): BuddyEditable => ({
  name: b.name,
  look: { ...b.look },
  instructions: b.instructions,
  permissions: {
    ...b.permissions,
    files: { read: [...b.permissions.files.read], write: [...b.permissions.files.write] }
  },
  model: b.model,
  report: b.report,
  budget: { ...b.budget },
  skills: [...b.skills],
  subagents: b.subagents
})

/** What is wrong with the form before it can be saved ([] = fine). */
export function formProblems(f: BuddyEditable): string[] {
  const out: string[] = []
  if (!f.name.trim()) out.push('Give it a name.')
  if (f.name.trim().length > 40) out.push('Keep the name to 40 letters.')
  if (!f.instructions.trim()) out.push('Say what it should do.')
  if (f.instructions.length > 8000)
    out.push('The instructions are too long (8,000 letters at most).')
  return out
}

/**
 * The draft to save from the review card: its form, its first line, and the schedule phrase.
 * Main reads only the phrase and parses it again, so an edited phrase keeps the old trigger here.
 */
export function draftToSave(f: BuddyEditable, when: string, orig?: BuddySchedule): BuddyDraft {
  const first = f.instructions.trim().split(/\r?\n/)[0] ?? ''
  const phrase = when.trim().slice(0, 120)
  const schedule = phrase
    ? ({
        text: phrase,
        trigger: orig?.trigger ?? null,
        description: ''
      } as unknown as BuddySchedule)
    : undefined
  return {
    ...editableOf(f),
    name: f.name.trim(),
    description: shorten(first, 300),
    ...(schedule ? { schedule } : {})
  }
}

/** Fields that changed against the saved buddy (only those are sent). */
export function changedFields(f: BuddyEditable, saved: BuddyEditable): Partial<BuddyEditable> {
  const out: Partial<BuddyEditable> = {}
  for (const k of Object.keys(f) as (keyof BuddyEditable)[])
    if (JSON.stringify(f[k]) !== JSON.stringify(saved[k]))
      (out as Record<string, unknown>)[k] = f[k]
  return out
}
