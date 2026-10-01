// Skills the model writes from a description (11 F9, Claude-style): "make a skill that …",
// Settings → Skills → New skill → "Write it for me", and other kinds of skills (a reply style)
// through `authorSkill`. The model writes the whole SKILL.md: name, description, when to use
// it, trigger phrases, instructions that guide a model run across apps (no coordinates), the
// permissions it needs (least privilege, clamped here), steps.json only for a fixed sequence,
// and small reference files. Everything is validated with the same parsers the loader and the
// `.lumen` installer use. Nothing is written here: the draft goes through the voice review or
// the Settings preview, and only a saved draft becomes the user's own skill.
import { z } from 'zod'
import type { SkillPermissions } from '@shared/types'
import { getProvider } from '../ai/providers'
import {
  draftFiles,
  freeName,
  slugName,
  type DraftFile,
  type DraftParam,
  type SkillDraft
} from './authoring'
import { INPUT_TOOL_NAMES, SKILL_TOOL_NAMES, websitePattern, websiteWords } from './clamp'
import { EXTRA_FILE_MAX_BYTES, EXTRA_FILE_RE, EXTRA_FILES_MAX } from './manage'
import { parseSkillFile } from './manifest'
import { StepsFileError, parseStepsFile } from './steps'

export { SKILL_TOOL_NAMES, websitePattern }

// ---- the model's output (strict structured output: every field required, no bounds) ----

export const composeSchema = z.object({
  name: z.string(),
  description: z.string(),
  when_to_use: z.string(),
  triggers: z.array(z.string()),
  instructions: z.string(),
  params: z.array(z.object({ name: z.string(), description: z.string() })),
  apps: z.array(z.string()),
  needs_input: z.boolean(),
  websites: z.array(z.string()),
  profile: z.boolean(),
  connectors: z.array(z.string()),
  tools: z.array(z.string()),
  steps_json: z.string(),
  references: z.array(z.object({ file: z.string(), content: z.string() }))
})

export type ComposeOutput = z.infer<typeof composeSchema>

export const COMPOSE_PROMPT = `You write skills for Lumen, an assistant that sees and operates a Windows PC (UI Automation, keyboard, browser). A skill is a SKILL.md: a short header plus instructions another model run follows when the user's request fits.

Write the skill the user describes. Return JSON:
- name: 2 to 4 lowercase words joined by "-" ("morning-mail").
- description: one sentence, at most 25 words, what it does. No "This skill".
- when_to_use: one sentence: the requests it fits ("when the user asks to tidy the desktop").
- triggers: 1 to 3 short phrases the user could say to run it, lowercase, no punctuation.
- instructions: the body, at most 40 lines. Imperative, numbered steps in plain words. Describe controls by their visible names and what to look for, never by coordinates or pixel positions, so it works when windows move and across apps that do the same job. Say which tools you expect (observe, act, keys, navigate, launch_app, wait_for, ask_user). Ask the user (ask_user) for anything missing instead of guessing. Use {param} placeholders for values that change between runs. Never put passwords or secrets in it. End with what "done" looks like.
- params: values that change between runs: name (lowercase letters and _), description (a few words). [] when none.
- apps: app ids from the list given that the skill is only for; [] when it works in any app.
- needs_input: true only if the skill must click, type, press keys, open web pages or start apps. false when it only reads the screen and answers.
- websites: https origins it must open, like "https://mail.google.com". [] when none. Only what the task needs.
- profile: true only if it must use the user's saved name, address or email.
- connectors: connector ids from the list given that it needs; [] when none.
- tools: the agent tools it needs from: ${SKILL_TOOL_NAMES.join(', ')}. [] means any.
- steps_json: "" in almost every case. Only when the task is the same fixed sequence of shortcut keys or URLs every time, a JSON text {"version":1,"steps":[...]} with steps {"do":"keys","combo":"ctrl+s"}, {"do":"navigate","url":"https://..."}, {"do":"launch_app","app":"Notepad"} or {"do":"wait","for":{"kind":"window_title","value":"..."}}. Never guess element names for it.
- references: [] usually. For long lists or templates the instructions point at (a reply template, a checklist), up to 3 files: file ("tone.md"), content (plain text, under 300 lines). Mention each in the instructions as reference/<file>.

Least privilege: ask only for what the task needs. Nothing for web pages the task does not open.`

/** What `authorSkill` writes from. */
export interface AuthorSkillRequest {
  /** The user's words: "a skill that opens my mail and reads today's events". */
  description: string
  /**
   * The kind of skill. 'style' = a reply style (how Lumen words answers): no input, no web,
   * no steps. Anything else is a task skill.
   */
  kind?: string
  /** App-pack ids the model may name in `apps`. */
  apps?: string[]
  /** Connector ids the model may name in `connectors`. */
  connectors?: string[]
  /** The user's names for those connectors (id → name), shown next to the ids. */
  connectorNames?: Record<string, string>
  /** Extra context for the model (what ran, the foreground app). */
  context?: string
}

export type ComposeWords = (turn: string) => Promise<ComposeOutput | null>

export interface AuthoredSkill {
  draft: SkillDraft
  files: ReturnType<typeof draftFiles>
  /** Things dropped or changed while checking the model's output. */
  warnings: string[]
  kind?: string
}

export type AuthorSkillResult = ({ ok: true } & AuthoredSkill) | { ok: false; error: string }

const STYLE_NOTE =
  'This is a reply-style skill: its instructions say how Lumen should word its answers (tone, length, format) while it is on. needs_input false, websites [], steps_json "", tools [].'

/** "github (GitHub issues)"; the name is the user's own text, cut short and on one line. */
function connectorLabel(id: string, names?: Record<string, string>): string {
  const n = names?.[id]
    ?.replace(/[\s()]+/g, ' ')
    .trim()
    .slice(0, 40)
  return n && n.toLowerCase() !== id ? `${id} (${n})` : id
}

export function composeTurn(req: AuthorSkillRequest): string {
  return [
    `The user wants a skill: ${req.description.trim().slice(0, 2000)}`,
    ...(req.kind === 'style' ? ['', STYLE_NOTE] : []),
    '',
    `App ids: ${req.apps?.length ? req.apps.join(', ') : '(none)'}`,
    `Connector ids: ${req.connectors?.length ? req.connectors.map((c) => connectorLabel(c, req.connectorNames)).join(', ') : '(none)'}`,
    ...(req.context ? ['', 'Context:', req.context.slice(0, 4000)] : [])
  ].join('\n')
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)
const PARAM_RE = /^[a-z_][a-z0-9_]{0,31}$/
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * The model's output as a draft, clamped to least privilege: only known apps, connectors and
 * tools; https origins only; no input tools without input; steps only for an input skill and
 * only when they parse; reference files renamed into reference/ and capped.
 */
export function draftFromCompose(
  out: ComposeOutput,
  req: AuthorSkillRequest,
  taken: (name: string) => boolean = () => false
): { draft: SkillDraft; warnings: string[] } {
  const warnings: string[] = []
  const style = req.kind === 'style'
  const name = freeName(
    slugName(out.name) ||
      slugName(req.description.split(/\s+/).slice(0, 4).join(' ')) ||
      'my-skill',
    taken
  )
  const description =
    oneLine(out.description, 200) || oneLine(req.description, 200) || 'A skill you described.'
  const whenToUse = oneLine(out.when_to_use, 200)
  const triggers = [
    ...new Set(
      out.triggers
        .map((t) => oneLine(t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' '), 80))
        .filter((t) => t.length >= 2)
    )
  ].slice(0, 5)
  const params: DraftParam[] = []
  for (const p of out.params) {
    const n = p.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!PARAM_RE.test(n) || params.some((x) => x.name === n) || params.length >= 20) continue
    const d = oneLine(p.description, 200)
    params.push({ name: n, ...(d ? { description: d } : {}) })
  }
  const knownApps = new Set(req.apps ?? [])
  const apps = out.apps.filter((a) => knownApps.has(a) && KEBAB_RE.test(a)).slice(0, 10)
  const input = !style && out.needs_input
  const network: string[] = []
  for (const w of style ? [] : out.websites) {
    const p = websitePattern(w)
    if (!p) warnings.push(`left out the website "${oneLine(w, 80)}" (https addresses only)`)
    else if (!network.includes(p) && network.length < 10) network.push(p)
  }
  if (network.length && !input) warnings.push('opening web pages needs mouse and keyboard')
  const knownConnectors = new Set(req.connectors ?? [])
  const connectors = style ? [] : out.connectors.filter((c) => knownConnectors.has(c)).slice(0, 10)
  const known = new Set<string>(SKILL_TOOL_NAMES)
  let tools = style ? [] : [...new Set(out.tools.filter((t) => known.has(t)))]
  if (!input) tools = tools.filter((t) => !INPUT_TOOL_NAMES.has(t))
  if (tools.length && !tools.includes('finish')) tools.push('finish')

  let steps: SkillDraft['steps']
  const stepsText = style ? '' : out.steps_json.trim()
  if (stepsText) {
    if (!input) warnings.push('left out the fixed steps: the skill does not use mouse or keyboard')
    else {
      try {
        steps = parseStepsFile(stepsText)
      } catch (e) {
        warnings.push(
          `left out the fixed steps (${e instanceof StepsFileError ? e.message : 'not valid'}); the AI guides every run`
        )
      }
    }
  }

  const references: DraftFile[] = []
  for (const r of style ? out.references.slice(0, 1) : out.references) {
    const base = slugName(r.file.replace(/\.(md|txt)$/i, ''), 40)
    const path = base ? `reference/${base}.md` : ''
    const text = r.content.replace(/\r\n?/g, '\n').trim()
    if (!path || !text || !EXTRA_FILE_RE.test(path) || references.some((x) => x.path === path))
      continue
    if (Buffer.byteLength(text, 'utf8') > EXTRA_FILE_MAX_BYTES) {
      warnings.push(`left out ${path}: longer than 16 KB`)
      continue
    }
    if (references.length >= Math.min(3, EXTRA_FILES_MAX)) break
    references.push({ path, text: `${text}\n` })
  }

  const instructions =
    out.instructions.trim().slice(0, 8000) ||
    `Do this for the user: ${oneLine(req.description, 600)}\n\nIf something is unclear, ask one short question.`

  const draft: SkillDraft = {
    name,
    description,
    triggers,
    params,
    instructions,
    permissions: {
      input,
      network: input ? network : [],
      ...(out.profile && !style ? { profile: true } : {}),
      ...(connectors.length ? { connectors } : {})
    },
    ...(steps ? { steps } : {}),
    source: 'model',
    ...(whenToUse ? { whenToUse } : {}),
    ...(apps.length ? { apps } : {}),
    ...(tools.length ? { tools } : {}),
    ...(references.length ? { references } : {})
  }
  return { draft, warnings }
}

/**
 * The draft's files, checked like an installed skill (SKILL.md header schema, steps schema,
 * reference file names and sizes). Throws with a readable reason.
 */
export function validateDraftFiles(files: ReturnType<typeof draftFiles>): string[] {
  const parsed = parseSkillFile(files.skillMd)
  if (files.stepsJson) parseStepsFile(files.stepsJson)
  for (const f of files.extra ?? []) {
    if (!EXTRA_FILE_RE.test(f.path)) throw new Error(`"${f.path}" is not a reference file`)
    if (Buffer.byteLength(f.text, 'utf8') > EXTRA_FILE_MAX_BYTES)
      throw new Error(`${f.path} is larger than 16 KB`)
  }
  return parsed.warnings
}

/** Plain words for what a draft may do (the spoken permissions preview). */
export function permissionWords(
  p: Partial<SkillPermissions> & { input: boolean; network: string[] },
  apps: string[] = []
): string {
  const out: string[] = []
  if (p.input)
    out.push(
      apps.length
        ? `use your mouse and keyboard in ${apps.join(', ')}`
        : 'use your mouse and keyboard'
    )
  if (p.network.length) out.push(`open ${p.network.map(websiteWords).join(', ')}`)
  if (p.profile) out.push('read your saved profile')
  if (p.connectors?.length) out.push(`use the connectors ${p.connectors.join(', ')}`)
  if (!out.length) return 'It only reads the screen and answers.'
  const last = out.pop()!
  return `It may ${out.length ? `${out.join(', ')} and ${last}` : last}.`
}

const DEFAULT_TIMEOUT_MS = 45_000

/** The app's model (main role) writing a skill. */
export const modelComposeWords: ComposeWords = async (turn) => {
  const { llm, model, effort } = getProvider('main')
  const res = await llm.complete(
    {
      model,
      system: [{ text: COMPOSE_PROMPT, cacheable: true }],
      messages: [{ role: 'user', content: turn }],
      maxTokens: 4000,
      effort,
      schema: composeSchema,
      schemaName: 'lumen_skill'
    },
    AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  )
  return (res.data as ComposeOutput | undefined) ?? null
}

/**
 * Writes a skill from a description: model → clamped draft → validated files. Nothing is
 * saved; the caller shows it for review (voice draft review, Settings preview).
 */
export async function authorSkill(
  req: AuthorSkillRequest,
  opts: { words?: ComposeWords; taken?: (name: string) => boolean } = {}
): Promise<AuthorSkillResult> {
  const description = req.description.trim()
  if (description.length < 4) return { ok: false, error: 'say what the skill should do' }
  let out: ComposeOutput | null
  try {
    out = await (opts.words ?? modelComposeWords)(composeTurn(req))
  } catch (e) {
    return { ok: false, error: `the AI could not write it (${(e as Error).message})` }
  }
  const parsed = out ? composeSchema.safeParse(out) : null
  if (!parsed?.success) return { ok: false, error: 'the AI did not return a skill' }
  const { draft, warnings } = draftFromCompose(parsed.data, req, opts.taken)
  try {
    const files = draftFiles(draft)
    warnings.push(...validateDraftFiles(files))
    return { ok: true, draft, files, warnings, ...(req.kind ? { kind: req.kind } : {}) }
  } catch (e) {
    return { ok: false, error: `the skill it wrote is not valid: ${(e as Error).message}` }
  }
}

// ---- voice ----

const norm = (s: string): string =>
  s
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:ok|okay|hey lumen|lumen|please)[,\s]+/i, '')
    .replace(/[.!?]+$/, '')

const COMPOSE_RE =
  /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:make|create|write|build|add|set up)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?skill\s*(?:that|which|to|for|so that|so|where|:|-)\s*(.{4,})$/i

/** "make a skill that opens my mail", "create a skill for tidying the desktop" → description. */
export function matchComposeIntent(utterance: string): { description: string } | null {
  if (!utterance || utterance.length > 600) return null
  const m = COMPOSE_RE.exec(norm(utterance))
  if (!m) return null
  const description = m[1].trim()
  // "create a skill: whenever I say …" is the local "when I say" draft (authoring.ts).
  if (/^when(?:ever)?\s+i\s+say\b/i.test(description)) return null
  return { description }
}
