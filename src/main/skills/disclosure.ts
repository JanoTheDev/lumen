// Progressive disclosure (11 T02, skills-and-background-agents.md §1), Claude-style:
//   L1 `skillIndexText`: one "name: description" line per enabled skill for the stable cached
//      prefix (≤ 40 skills, ≤ 1.5k tokens; over that, the active app's skills first and an
//      "N more" line pointing at list_skills). Built from frontmatter only, so a body edit
//      never changes it.
//   L2 `use_skill {name, args?}`: the body with {param} placeholders filled + a file listing.
//   L3 `read_skill_file {name, path}`: one text file inside the skill folder, ≤ 64 KB.
// Tool definitions follow the agent loop's ToolDef shape (zod, strict-mode subset: no bounds,
// no records). No Electron.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { z } from 'zod'
import type { SkillManifest } from '@shared/types'
import type { ToolDef } from '../ai/providers/types'
import { SKILL_FILE, estimateTokens } from './manifest'
import type { LoadedSkill, SkillRegistry } from './registry'

export const INDEX_MAX_SKILLS = 40
export const INDEX_MAX_TOKENS = 1500
export const SKILL_FILE_MAX_BYTES = 64 * 1024
const LIST_MAX = 30
const FILES_MAX = 60
/** Text files read_skill_file may return. */
export const TEXT_EXT = ['.md', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.html']

export interface SkillIndexContext {
  /** App-pack id of the foreground app (boosts its skills when the list is cut). */
  app?: string | null
  maxSkills?: number
  maxTokens?: number
}

const HEADER =
  'Skills (abilities the user installed). Each line is "name: what it does". When one fits the request, call use_skill with its name to load its instructions before acting; never guess them.'

function line(m: SkillManifest): string {
  const when = m.when_to_use ? ` Use when: ${m.when_to_use}` : ''
  return `- ${m.name}: ${m.description}${when}`.replace(/\s+/g, ' ').trim()
}

/** L1 for the cached prefix; "" when no skill is enabled. */
export function skillIndexText(registry: SkillRegistry, ctx: SkillIndexContext = {}): string {
  const skills = registry.enabled().map((s) => s.manifest)
  if (!skills.length) return ''
  const maxSkills = ctx.maxSkills ?? INDEX_MAX_SKILLS
  const maxTokens = ctx.maxTokens ?? INDEX_MAX_TOKENS
  const all = skills.map(line)
  const full = [HEADER, ...all].join('\n')
  // Everything fits: alphabetical, independent of the foreground app, so the prefix stays put.
  if (skills.length <= maxSkills && estimateTokens(full) <= maxTokens) return full

  const app = ctx.app ?? null
  const ranked = [...skills].sort((a, b) => {
    const boost = (m: SkillManifest): number => (app && m.apps.includes(app) ? 0 : 1)
    return boost(a) - boost(b) || a.name.localeCompare(b.name)
  })
  const kept: string[] = []
  for (const m of ranked) {
    if (kept.length >= maxSkills) break
    const more = skills.length - kept.length - 1
    const tail = more > 0 ? `\n${moreLine(more)}` : ''
    if (estimateTokens([HEADER, ...kept, line(m)].join('\n') + tail) > maxTokens) break
    kept.push(line(m))
  }
  const rest = skills.length - kept.length
  return [HEADER, ...kept, ...(rest ? [moreLine(rest)] : [])].join('\n')
}

const moreLine = (n: number): string =>
  `${n} more ${n === 1 ? 'skill' : 'skills'}: call list_skills with a few words to search them.`

// ---- tools ----

export const useSkillInput = z.object({
  name: z.string().describe('The skill name from the skills list, e.g. "clean-downloads".'),
  args: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional()
    .describe('Values for the skill’s parameters, when it has any.')
})

export const readSkillFileInput = z.object({
  name: z.string().describe('The skill name.'),
  path: z
    .string()
    .describe(
      'A file path from the use_skill file list, relative to the skill, e.g. "reference/tone.md".'
    )
})

export const listSkillsInput = z.object({
  query: z
    .string()
    .optional()
    .describe('A few words to search names and descriptions; empty lists all.')
})

export const SKILL_TOOLS = {
  use_skill: {
    name: 'use_skill',
    description:
      'Loads a skill’s instructions (and its list of extra files). Call it before doing a task a listed skill covers, then follow the instructions within your other tools and the skill’s permissions.',
    schema: useSkillInput
  },
  read_skill_file: {
    name: 'read_skill_file',
    description:
      'Reads one text file bundled with a skill (reference notes, templates, examples) when its instructions point at it. Only files inside that skill; up to 64 KB.',
    schema: readSkillFileInput
  },
  list_skills: {
    name: 'list_skills',
    description:
      'Searches all enabled skills by name and description. Use it when the skills list says more skills exist.',
    schema: listSkillsInput
  }
} satisfies Record<string, ToolDef>

export type SkillToolName = keyof typeof SKILL_TOOLS

/** The tool definitions; list_skills only when the L1 list was cut. */
export function skillToolDefs(opts: { truncated?: boolean } = {}): ToolDef[] {
  return opts.truncated
    ? [SKILL_TOOLS.use_skill, SKILL_TOOLS.read_skill_file, SKILL_TOOLS.list_skills]
    : [SKILL_TOOLS.use_skill, SKILL_TOOLS.read_skill_file]
}

/** Whether skillIndexText left skills out (so list_skills belongs in the tool set). */
export function indexTruncated(registry: SkillRegistry, ctx: SkillIndexContext = {}): boolean {
  return /^\d+ more skills?: /m.test(skillIndexText(registry, ctx))
}

/** Same shape as the agent loop's ToolOutcome. */
export interface SkillToolOutcome {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  label?: string
}

const ok = (text: string, label?: string): SkillToolOutcome => ({
  content: [{ type: 'text', text }],
  ...(label ? { label } : {})
})
const fail = (text: string): SkillToolOutcome => ({
  content: [{ type: 'text', text }],
  isError: true
})

export type SkillArgs =
  | { name: string; value: string }[]
  | Record<string, string | number | boolean>
  | undefined

function argMap(args: SkillArgs): Record<string, string> {
  if (!args) return {}
  if (Array.isArray(args)) return Object.fromEntries(args.map((a) => [a.name, String(a.value)]))
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
}

/** Fills declared {param} placeholders. Returns the text and the params still missing. */
export function fillParams(
  body: string,
  m: SkillManifest,
  args: SkillArgs
): { text: string; missing: string[]; problems: string[] } {
  const { values, missing, problems } = resolveParams(m, args)
  const text = body.replace(/\{([A-Za-z_]\w*)\}/g, (all, key: string) =>
    key in values ? values[key] : all
  )
  return { text, missing, problems }
}

/** Values for the declared params (given, else default), the ones missing, and bad values. */
export function resolveParams(
  m: SkillManifest,
  args: SkillArgs
): { values: Record<string, string>; missing: string[]; problems: string[] } {
  const given = argMap(args)
  const values: Record<string, string> = {}
  const missing: string[] = []
  const problems: string[] = []
  for (const [key, p] of Object.entries(m.params)) {
    const v = given[key] ?? (p.default !== undefined ? String(p.default) : undefined)
    if (v === undefined) {
      missing.push(key)
      continue
    }
    if (p.type === 'number' && !Number.isFinite(Number(v))) problems.push(`${key} must be a number`)
    if (p.type === 'boolean' && v !== 'true' && v !== 'false')
      problems.push(`${key} must be true or false`)
    if (p.enum && !p.enum.map(String).includes(v))
      problems.push(`${key} must be one of ${p.enum.join(', ')}`)
    values[key] = v
  }
  for (const key of Object.keys(given))
    if (!(key in m.params)) problems.push(`unknown parameter "${key}"`)
  return { values, missing, problems }
}

/** Files of a skill (names + sizes), SKILL.md and hidden files left out. */
export function skillFiles(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = []
  const walk = (sub: string, depth: number): void => {
    if (depth > 4 || out.length >= FILES_MAX) return
    let names: string[] = []
    try {
      names = readdirSync(join(dir, sub)).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith('.') || (!sub && n === SKILL_FILE)) continue
      const rel = sub ? `${sub}/${n}` : n
      const st = lstatSync(join(dir, rel))
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(rel, depth + 1)
      else if (st.isFile() && out.length < FILES_MAX) out.push({ path: rel, bytes: st.size })
    }
  }
  walk('', 0)
  return out
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

export interface SkillToolOptions {
  /** May this caller use the skill (enabled, allowed in this context)? Default: enabled. */
  allow?: (s: LoadedSkill) => boolean
  /** Called when a body is loaded (the runner / audit log hooks in here). */
  onUse?: (s: LoadedSkill, args: Record<string, string>) => void
}

/** L2: the body for the model, or a tool error. */
export function loadSkill(
  registry: SkillRegistry,
  input: { name: string; args?: SkillArgs },
  opts: SkillToolOptions = {}
): SkillToolOutcome {
  const s = registry.get(input.name)
  const allowed = s && (opts.allow ? opts.allow(s) : registry.isEnabled(s.manifest.name))
  if (!s || !allowed) return fail(`No enabled skill named "${input.name}".`)
  let body: string
  try {
    body = registry.body(s.manifest.name)
  } catch (e) {
    return fail(`The skill "${input.name}" could not be read: ${(e as Error).message}`)
  }
  const filled = fillParams(body, s.manifest, input.args)
  if (filled.problems.length) return fail(`Bad arguments: ${filled.problems.join('; ')}.`)
  opts.onUse?.(s, argMap(input.args))
  const m = s.manifest
  const files = skillFiles(s.dir)
  const parts = [
    `<skill name="${m.name}" version="${m.version}" trust="${registry.trustOf(s)}">`,
    filled.text,
    '</skill>'
  ]
  if (filled.missing.length)
    parts.push(`Missing values (ask the user before starting): ${filled.missing.join(', ')}.`)
  parts.push(permissionLine(m))
  if (files.length)
    parts.push(
      `Files (read with read_skill_file when the instructions point at them):\n${files
        .map((f) => `- ${f.path} (${kb(f.bytes)})`)
        .join('\n')}`
    )
  return ok(parts.join('\n'), `Using skill ${m.name}`)
}

function permissionLine(m: SkillManifest): string {
  const p = m.permissions
  const can: string[] = []
  if (p.input)
    can.push(
      m.apps.length
        ? `use the mouse and keyboard in ${m.apps.join(', ')}`
        : 'use the mouse and keyboard'
    )
  if (p.network.length) can.push(`open ${p.network.join(', ')}`)
  if (p.files.read.length) can.push(`read files in ${p.files.read.join(', ')}`)
  if (p.files.write.length) can.push(`change files in ${p.files.write.join(', ')}`)
  if (p.connectors.length) can.push(`use ${p.connectors.join(', ')}`)
  if (p.profile) can.push('read the user profile')
  if (p.screen) can.push('look at the screen in the background')
  const extra = p.risky ? ' Every action needs the user’s OK.' : ''
  return `Permissions: ${can.length ? `this skill may ${can.join('; ')}` : 'this skill may only read and answer'}. Anything else will be refused.${extra}`
}

/** Why a requested path is unsafe, or null. */
function badPath(path: string): string | null {
  const p = path.trim()
  if (!p) return 'empty path'
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\') || p.startsWith('/'))
    return 'absolute paths are not allowed'
  const parts = p.split(/[\\/]+/)
  if (parts.some((x) => x === '..')) return '".." is not allowed'
  if (parts.some((x) => x.startsWith('.'))) return 'hidden files are not allowed'
  if (/[:*?"<>|]/.test(p) || [...p].some((c) => c.charCodeAt(0) < 32))
    return 'bad characters in the path'
  return null
}

/** L3: one text file inside the skill folder. */
export function readSkillFile(
  registry: SkillRegistry,
  input: { name: string; path: string },
  opts: SkillToolOptions = {}
): SkillToolOutcome {
  const s = registry.get(input.name)
  const allowed = s && (opts.allow ? opts.allow(s) : registry.isEnabled(s.manifest.name))
  if (!s || !allowed) return fail(`No enabled skill named "${input.name}".`)
  const why = badPath(input.path)
  if (why) return fail(`Cannot read "${input.path}": ${why}.`)
  const rel = input.path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!TEXT_EXT.includes(extname(rel).toLowerCase()))
    return fail(`Cannot read "${rel}": only text files (${TEXT_EXT.join(' ')}) can be read.`)
  let file: string
  try {
    const root = realpathSync(s.dir)
    file = realpathSync(resolve(s.dir, ...rel.split('/')))
    const r = relative(root, file)
    if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep)[0] === '..')
      return fail(`Cannot read "${rel}": it is outside the skill.`)
  } catch {
    return fail(`No file "${rel}" in skill ${s.manifest.name}.`)
  }
  const st = statSync(file)
  if (!st.isFile()) return fail(`"${rel}" is not a file.`)
  if (st.size > SKILL_FILE_MAX_BYTES) return fail(`"${rel}" is larger than 64 KB.`)
  const data = readFileSync(file)
  if (data.includes(0)) return fail(`"${rel}" is not a text file.`)
  return ok(
    `<skill_file skill="${s.manifest.name}" path="${rel}">\n${data.toString('utf8')}\n</skill_file>`,
    `Read ${rel}`
  )
}

/** list_skills: enabled skills matching every word of the query. */
export function listSkills(
  registry: SkillRegistry,
  input: { query?: string },
  opts: SkillToolOptions = {}
): SkillToolOutcome {
  const words = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const pool = registry
    .all()
    .filter((s) => (opts.allow ? opts.allow(s) : registry.isEnabled(s.manifest.name)))
  const hits = pool.filter((s) => {
    const m = s.manifest
    const hay = [m.name, m.description, m.when_to_use ?? '', ...m.triggers, ...m.apps]
      .join(' ')
      .toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  if (!hits.length) return ok('No matching skills.')
  const shown = hits.slice(0, LIST_MAX).map((s) => line(s.manifest))
  const more = hits.length - shown.length
  return ok([...shown, ...(more ? [`${more} more; narrow the search.`] : [])].join('\n'))
}

/** Handlers for the agent loop, keyed by tool name. */
export function createSkillToolHandlers(
  registry: SkillRegistry,
  opts: SkillToolOptions = {}
): Record<SkillToolName, (input: Record<string, unknown>) => Promise<SkillToolOutcome>> {
  const parsed = <T extends z.ZodType>(
    schema: T,
    i: unknown,
    run: (v: z.infer<T>) => SkillToolOutcome
  ): Promise<SkillToolOutcome> => {
    const r = schema.safeParse(i)
    return Promise.resolve(r.success ? run(r.data) : fail('Invalid input for this tool.'))
  }
  return {
    use_skill: (i) => parsed(useSkillInput, i, (v) => loadSkill(registry, v, opts)),
    read_skill_file: (i) => parsed(readSkillFileInput, i, (v) => readSkillFile(registry, v, opts)),
    list_skills: (i) => parsed(listSkillsInput, i, (v) => listSkills(registry, v, opts))
  }
}
