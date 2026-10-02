// Buddies the model writes from a description (08 T51): "make a buddy that …" by voice and
// Settings → Buddies → "Make a buddy for me". The main model writes the name, look (a colour
// from a fixed palette + one emoji), instructions, the permissions it needs (least privilege,
// clamped here like model-written skills: known tools / connectors / skills, https origins,
// folders only when they resolve locally), its model, report style and an optional schedule as
// a "when" phrase, parsed locally with the automation grammar. The schedule is only proposed:
// creating the automation (action buddy) is the caller's. Nothing is written here.
import { z } from 'zod'
import {
  BUDDY_DEFAULT_PER_RUN_USD,
  BUDDY_INSTRUCTIONS_MAX,
  BUDDY_NAME_MAX,
  type BuddyDraft,
  type BuddyModel,
  type BuddyPermissions,
  type BuddyReport,
  type BuddySchedule
} from '@shared/buddies'
import { getProvider } from '../ai/providers'
import { parseTriggerText } from '../routines/parse'
import { describeTrigger } from '../routines/triggers'
import { websitePattern, websiteWords } from '../skills/clamp'
import { withUsageFeature } from '../usage/scope'
import {
  BUDDY_TOOL_NAMES,
  clampBuddy,
  clampPermissions,
  folderAllowed,
  safeBuddyName
} from './clamp'

// ---- the model's output (strict structured output: every field required) ----

export const buddyComposeSchema = z.object({
  name: z.string(),
  color: z.string(),
  emoji: z.string(),
  description: z.string(),
  instructions: z.string(),
  tools: z.array(z.string()),
  websites: z.array(z.string()),
  connectors: z.array(z.string()),
  read_folders: z.array(z.string()),
  write_folders: z.array(z.string()),
  profile: z.boolean(),
  needs_screen: z.boolean(),
  skills: z.array(z.string()),
  subagents: z.boolean(),
  model: z.string(),
  report: z.string(),
  schedule: z.string()
})

export type BuddyComposeOutput = z.infer<typeof buddyComposeSchema>

/** The look palette: names the model picks from → the colours clamp.ts also uses. */
export const BUDDY_COLORS: Record<string, string> = {
  blue: '#5b8def',
  coral: '#e0705a',
  green: '#4fb286',
  purple: '#c47fd5',
  amber: '#e3a33b',
  teal: '#3fb3c4',
  pink: '#d8648f'
}

const REPORTS: readonly BuddyReport[] = ['notify', 'spoken', 'silent', 'cards']

export const BUDDY_COMPOSE_PROMPT = `You design buddies for Lumen, an assistant on a Windows PC. A buddy is a small named helper with one job that runs in the background (on a schedule or when the user calls it) and reports back.

Write the buddy the user describes. Return JSON:
- name: 1 or 2 words + "Buddy", title case ("Inbox Buddy", "Price Buddy").
- color: one of ${Object.keys(BUDDY_COLORS).join(', ')}.
- emoji: one emoji that fits the job.
- description: one sentence, at most 20 words, what it does. No "This buddy".
- instructions: at most 30 lines for the model that runs it: what it is for, numbered steps in plain words, what to remember in its notebook (memory_write) between runs, and what to report (short). Never coordinates, passwords or secrets.
- tools: the background tools it needs from: ${BUDDY_TOOL_NAMES.join(', ')}. finish, ask_user, memory_write and notify are always given. Only what the job needs.
- websites: https origins it reads with fetch_url ("https://www.example.com"). [] when none.
- connectors: connector ids from the list given that it needs. [] when none.
- read_folders / write_folders: folders it reads / changes files in, by name ("Downloads", "Documents") or full path. [] when none.
- profile: true only if it must use the user's saved name, address or email.
- needs_screen: true only if the job cannot be done without operating apps on screen (most jobs can be done by reading web pages, files or connectors).
- skills: skill names from the list given it should use. [] when none.
- subagents: true only for big research jobs that split well into parallel parts.
- model: "fast" for simple checks and summaries, "main" for writing or judgement.
- report: "notify" (a notification, default), "spoken" (say it when the user is around), "silent" (only into the Tasks list), "cards" (answer cards for products, places, trips).
- schedule: when it should run by itself as a short phrase: "every weekday at 8", "every day at 9", "every hour between 9 and 5", "every month on the 1st at 10", "when a PDF lands in Downloads", "when I log in". "" when the user did not ask for a schedule or it only runs when called.

Least privilege: ask only for what the job needs.`

export interface AuthorBuddyRequest {
  /** The user's words: "a buddy that checks my mail every morning". */
  description: string
  /** Connector ids the model may name, and the user's names for them. */
  connectors?: string[]
  connectorNames?: Record<string, string>
  /** Skill names the model may name. */
  skills?: string[]
  /** App-pack ids a buddy that works on screen may be limited to. */
  apps?: string[]
  context?: string
}

export type BuddyComposeWords = (turn: string) => Promise<BuddyComposeOutput | null>

export interface AuthorBuddyOptions {
  words?: BuddyComposeWords
  /** A buddy of this name exists. */
  taken?: (name: string) => boolean
  /** "downloads" / a path → a local folder, or null (routines resolveFolder). */
  resolveFolder?: (name: string) => string | null
  now?: number
}

export type AuthorBuddyResult =
  | { ok: true; draft: BuddyDraft; warnings: string[] }
  | { ok: false; error: string }

export function buddyComposeTurn(req: AuthorBuddyRequest): string {
  const label = (id: string): string => {
    const n = req.connectorNames?.[id]
      ?.replace(/[\s()]+/g, ' ')
      .trim()
      .slice(0, 40)
    return n && n.toLowerCase() !== id ? `${id} (${n})` : id
  }
  return [
    `The user wants a buddy: ${req.description.trim().slice(0, 2000)}`,
    '',
    `Connector ids: ${req.connectors?.length ? req.connectors.map(label).join(', ') : '(none)'}`,
    `Skills: ${req.skills?.length ? req.skills.slice(0, 60).join(', ') : '(none)'}`,
    ...(req.context ? ['', 'Context:', req.context.slice(0, 4000)] : [])
  ].join('\n')
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** "Inbox Buddy" when free, else "Inbox Buddy 2" … */
export function freeBuddyName(name: string, taken: (name: string) => boolean): string {
  const base = safeBuddyName(oneLine(name, BUDDY_NAME_MAX - 3) || 'My Buddy')
  if (!taken(base)) return base
  for (let n = 2; n < 100; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`
  return `${base} ${Date.now().toString(36).slice(-2)}`
}

/** A "when" phrase as a proposed schedule; a reason when it does not parse. */
export function parseSchedule(
  text: string,
  opts: { now: number; resolveFolder?: (name: string) => string | null }
): { schedule: BuddySchedule } | { reason: string } | null {
  const phrase = oneLine(text, 120).replace(/[.!?]+$/, '')
  if (!phrase) return null
  const r = parseTriggerText(phrase, {
    now: opts.now,
    ...(opts.resolveFolder ? { resolveFolder: opts.resolveFolder } : {})
  })
  if (!r.ok) return { reason: r.reason }
  return { schedule: { text: phrase, trigger: r.trigger, description: describeTrigger(r.trigger) } }
}

function folders(
  names: string[],
  resolve: AuthorBuddyOptions['resolveFolder'],
  warnings: string[]
): string[] {
  const out: string[] = []
  for (const n of names) {
    const p = resolve?.(n) ?? (folderAllowed(n) ? n : null)
    if (!p || !folderAllowed(p)) warnings.push(`left out the folder "${oneLine(n, 80)}"`)
    else if (!out.includes(p)) out.push(p)
  }
  return out
}

/** The model's output as a clamped draft (least privilege, known names only). */
export function draftFromBuddyCompose(
  out: BuddyComposeOutput,
  req: AuthorBuddyRequest,
  opts: AuthorBuddyOptions = {}
): { draft: BuddyDraft; warnings: string[] } {
  const warnings: string[] = []
  const name = freeBuddyName(
    oneLine(out.name, BUDDY_NAME_MAX) || 'My Buddy',
    opts.taken ?? (() => false)
  )
  const description =
    oneLine(out.description, 200) || oneLine(req.description, 200) || 'A buddy you described.'
  const network: string[] = []
  for (const w of out.websites) {
    const p = websitePattern(w)
    if (!p) warnings.push(`left out the website "${oneLine(w, 80)}" (https addresses only)`)
    else if (!network.includes(p)) network.push(p)
  }
  const tools = [...out.tools]
  if (network.length && !tools.includes('fetch_url')) tools.push('fetch_url')
  const knownConnectors = req.connectors ?? []
  const connectors = out.connectors.filter((c) => knownConnectors.includes(c))
  for (const c of out.connectors)
    if (!knownConnectors.includes(c)) warnings.push(`left out the unknown connector "${c}"`)
  const screen = out.needs_screen
  const permissions: BuddyPermissions = clampPermissions(
    {
      tools,
      apps: [],
      input: screen,
      network,
      files: {
        read: folders(out.read_folders, opts.resolveFolder, warnings),
        write: folders(out.write_folders, opts.resolveFolder, warnings)
      },
      connectors,
      profile: out.profile,
      risky: false,
      screen
    },
    { connectors: knownConnectors }
  )
  const knownSkills = req.skills ?? []
  const skills = out.skills.filter((s) => knownSkills.includes(s))
  const body = out.instructions.replace(/\r\n?/g, '\n').trim()
  const instructions = (
    body
      ? body.toLowerCase().startsWith(description.toLowerCase())
        ? body
        : `${description}\n\n${body}`
      : `${description}\n\nDo this for the user: ${oneLine(req.description, 600)}\nIf something is unclear, ask one short question.`
  ).slice(0, BUDDY_INSTRUCTIONS_MAX)
  const color = BUDDY_COLORS[out.color.trim().toLowerCase()] ?? BUDDY_COLORS.blue
  // clampBuddy checks the look (one emoji, else an initial).
  const look = clampBuddy('draft', { name, look: { color, emoji: out.emoji } }).look
  const model: BuddyModel = out.model === 'main' ? 'main' : 'fast'
  const report: BuddyReport = REPORTS.includes(out.report as BuddyReport)
    ? (out.report as BuddyReport)
    : 'notify'
  let schedule: BuddySchedule | undefined
  const s = parseSchedule(out.schedule, {
    now: opts.now ?? Date.now(),
    ...(opts.resolveFolder ? { resolveFolder: opts.resolveFolder } : {})
  })
  if (s && 'schedule' in s) schedule = s.schedule
  else if (s) warnings.push(`left out the schedule "${oneLine(out.schedule, 80)}": ${s.reason}`)
  return {
    draft: {
      name,
      look,
      description,
      instructions,
      permissions,
      model,
      report,
      budget: { perRunUsd: BUDDY_DEFAULT_PER_RUN_USD },
      skills,
      subagents: out.subagents,
      ...(schedule ? { schedule } : {})
    },
    warnings
  }
}

const folderWord = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Plain words for what a buddy may do (the spoken permissions line). */
export function buddyPermissionWords(p: BuddyPermissions): string {
  const out: string[] = []
  if (p.network.length) out.push(`read ${p.network.map(websiteWords).join(', ')}`)
  if (p.files.read.length) out.push(`read files in ${p.files.read.map(folderWord).join(', ')}`)
  if (p.files.write.length) out.push(`change files in ${p.files.write.map(folderWord).join(', ')}`)
  if (p.connectors.length) out.push(`use the connectors ${p.connectors.join(', ')}`)
  if (p.profile) out.push('read your saved profile')
  if (p.input)
    out.push(
      p.apps.length
        ? `use your mouse and keyboard in ${p.apps.join(', ')}`
        : 'use your mouse and keyboard in any app'
    )
  else if (p.screen) out.push('ask to work on your screen')
  const extra = p.tools.filter((t) => !['fetch_url', 'read_file', 'read_document'].includes(t))
  if (extra.length) out.push(`use ${extra.map((t) => t.replace(/_/g, ' ')).join(', ')}`)
  if (!out.length) return 'It only uses its notebook and answers.'
  const last = out.pop()!
  return `It may ${out.length ? `${out.join(', ')} and ${last}` : last}.`
}

/** Fields for createBuddy from a saved draft (trust mine, no schedules yet). */
export function buddyFields(d: BuddyDraft): {
  name: string
  look: BuddyDraft['look']
  instructions: string
  permissions: BuddyPermissions
  model: BuddyModel
  report: BuddyReport
  budget: BuddyDraft['budget']
  skills: string[]
  subagents: boolean
} {
  return {
    name: d.name,
    look: d.look,
    instructions: d.instructions,
    permissions: d.permissions,
    model: d.model,
    report: d.report,
    budget: d.budget,
    skills: d.skills,
    subagents: d.subagents
  }
}

const TIMEOUT_MS = 45_000

/** The app's model (main role) writing a buddy. */
export const modelBuddyWords: BuddyComposeWords = async (turn) => {
  const { llm, model, effort } = getProvider('main')
  const res = await withUsageFeature('buddy-write', () =>
    llm.complete(
      {
        model,
        system: [{ text: BUDDY_COMPOSE_PROMPT, cacheable: true }],
        messages: [{ role: 'user', content: turn }],
        maxTokens: 3000,
        effort,
        schema: buddyComposeSchema,
        schemaName: 'lumen_buddy'
      },
      AbortSignal.timeout(TIMEOUT_MS)
    )
  )
  return (res.data as BuddyComposeOutput | undefined) ?? null
}

/** Writes a buddy from a description: model → clamped draft. Nothing is saved. */
export async function authorBuddy(
  req: AuthorBuddyRequest,
  opts: AuthorBuddyOptions = {}
): Promise<AuthorBuddyResult> {
  const description = req.description.trim()
  if (description.length < 4) return { ok: false, error: 'say what the buddy should do' }
  let out: BuddyComposeOutput | null
  try {
    out = await (opts.words ?? modelBuddyWords)(buddyComposeTurn({ ...req, description }))
  } catch (e) {
    return { ok: false, error: `the AI could not write it (${(e as Error).message})` }
  }
  const parsed = out ? buddyComposeSchema.safeParse(out) : null
  if (!parsed?.success) return { ok: false, error: 'the AI did not return a buddy' }
  return { ok: true, ...draftFromBuddyCompose(parsed.data, { ...req, description }, opts) }
}
