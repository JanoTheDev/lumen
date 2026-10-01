// Making skills (11 T09-T11, F9), the pure part: a draft skill from the last agent run, from a
// spoken "when I say X, do Y", or from a recording of the user's steps; the SKILL.md (and
// steps.json) written from a draft; and the voice phrases that start and review drafts.
// Steps come from what actually ran or was recorded, never from the model: the model only
// writes words (name, description, triggers, instructions) and says which typed values are
// parameters.
import { z } from 'zod'
import type { SkeletonStep } from '../teach/recorder'
import { SKILL_NAME_RE, parseSkillFile } from './manifest'
import {
  ELEMENT_OPS,
  stepsFileSchema,
  type ElementMatch,
  type SkillStep,
  type StepsFile
} from './steps'

// ---- the last agent run ----

/** One successful tool call of an agent run (memory only; typed values included). */
export interface TraceStep {
  tool: 'act' | 'keys' | 'navigate' | 'launch_app' | 'wait_for'
  op?: string
  /** The element acted on, resolved from the snapshot the model saw. */
  element?: ElementMatch
  /** act on visible text (no element id). */
  text?: string
  /** act on a mark or a point: not repeatable without the model. */
  positional?: boolean
  value?: string
  combo?: string
  url?: string
  app?: string
  wait?: { kind: 'window_title' | 'element' | 'text'; value: string; role?: string }
  timeoutMs?: number
}

export interface AgentRunTrace {
  prompt: string
  summary: string
  at: number
  steps: TraceStep[]
  /** The skill it ran, if any. */
  skill?: string
}

export interface DraftParam {
  name: string
  description?: string
  /** The value used in the run (replaced by {name} in the steps). */
  value?: string
}

export interface SkillDraft {
  name: string
  description: string
  triggers: string[]
  params: DraftParam[]
  instructions: string
  permissions: {
    input: boolean
    network: string[]
    /** Model-written skills only ask for these when the task needs them (least privilege). */
    profile?: boolean
    connectors?: string[]
  }
  steps?: StepsFile
  /** model: written by the model from a description ("make a skill that …"). */
  source: 'agent-run' | 'voice' | 'recording' | 'model'
  whenToUse?: string
  apps?: string[]
  /** The agent tools the skill may use (all foreground tools when absent). */
  tools?: string[]
  /** Bundled text files (L3), e.g. reference/tone.md. */
  references?: DraftFile[]
}

/** A bundled text file of a draft: a path under reference/ and its text. */
export interface DraftFile {
  path: string
  text: string
}

type ElementOp = (typeof ELEMENT_OPS)[number]
const isElementOp = (op: string): op is ElementOp => (ELEMENT_OPS as readonly string[]).includes(op)

/** The run as numbered lines for the model (typed values shown: the model saw them already). */
export function describeTrace(t: AgentRunTrace): string {
  return t.steps
    .map((s, i) => {
      const el = s.element
        ? `${s.element.role ? `${s.element.role} ` : ''}“${s.element.name ?? s.element.automationId}”`
        : s.text
          ? `text “${s.text}”`
          : s.positional
            ? 'a spot on the screen'
            : ''
      const what =
        s.tool === 'act'
          ? `${s.op ?? 'act'}${el ? ` ${el}` : ''}${s.value !== undefined ? ` value “${s.value}”` : ''}`
          : s.tool === 'keys'
            ? `press ${s.combo}`
            : s.tool === 'navigate'
              ? `open ${s.url}`
              : s.tool === 'launch_app'
                ? `start ${s.app}`
                : `wait for ${s.wait?.kind} “${s.wait?.value}”`
      return `${i + 1}. ${what}`
    })
    .join('\n')
}

const COMBO_RE = /^[\w+-]+$/

/**
 * steps.json from the run, or null when a step cannot repeat without the model (a mark or
 * point target, a scroll). Param values become {name} placeholders.
 */
export function traceToSteps(t: AgentRunTrace, params: DraftParam[] = []): SkillStep[] | null {
  const out: SkillStep[] = []
  for (const s of t.steps) {
    if (s.tool === 'keys') {
      const combo = (s.combo ?? '').toLowerCase().replace(/\s+/g, '')
      if (!COMBO_RE.test(combo)) return null
      out.push({ do: 'keys', combo })
    } else if (s.tool === 'navigate') {
      if (!s.url) return null
      out.push({ do: 'navigate', url: s.url })
    } else if (s.tool === 'wait_for') {
      if (!s.wait) return null
      out.push({
        do: 'wait',
        for: s.wait,
        ...(s.timeoutMs ? { timeoutMs: Math.min(15_000, Math.max(100, s.timeoutMs)) } : {})
      })
    } else if (s.tool === 'launch_app') {
      if (!s.app?.trim()) return null
      out.push({ do: 'launch_app', app: s.app.trim().slice(0, 100) })
    } else if (s.tool === 'act') {
      if (s.positional) return null
      const target: ElementMatch | undefined =
        s.element ?? (s.text ? { name: s.text.slice(0, 200) } : undefined)
      const op = s.op ?? ''
      if (op === 'type' || op === 'set_value') {
        out.push({ do: op, ...(target ? { target } : {}), value: s.value ?? '' })
      } else if (isElementOp(op) && target) {
        out.push({ do: op, target })
      } else return null
    } else return null
  }
  if (!out.length) return null
  return withPlaceholders(out, params)
}

function withPlaceholders(steps: SkillStep[], params: DraftParam[]): SkillStep[] {
  const subs = params
    .filter((p) => p.value && p.value.trim().length >= 2)
    .sort((a, b) => b.value!.length - a.value!.length)
  if (!subs.length) return steps
  const sub = (s: string, url = false): string => {
    let out = s
    for (const p of subs) {
      out = out.split(p.value!).join(`{${p.name}}`)
      if (url) out = out.split(encodeURIComponent(p.value!)).join(`{${p.name}}`)
    }
    return out
  }
  return steps.map((s) => {
    if ('value' in s) return { ...s, value: sub(s.value) }
    if (s.do === 'navigate') return { ...s, url: sub(s.url, true) }
    return s
  })
}

/** https origins the run opened, as permission patterns. */
export function traceNetwork(t: AgentRunTrace): string[] {
  const out = new Set<string>()
  for (const s of t.steps) {
    if (s.tool !== 'navigate' || !s.url) continue
    try {
      const u = new URL(s.url)
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(`${u.protocol}//${u.host}`)
    } catch {
      /* not a URL */
    }
  }
  return [...out].slice(0, 20)
}

// ---- the model's words ----

// Every field required (strict structured output on both providers).
export const authoringSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  instructions: z.string(),
  params: z.array(z.object({ name: z.string(), description: z.string(), value: z.string() }))
})

export type AuthoringText = z.infer<typeof authoringSchema>

export const AUTHORING_PROMPT = `You turn a task Lumen just did on a Windows PC (or steps the user recorded) into a reusable skill: short instructions another run can follow.

You get the user's request and the steps that ran, in order. Return JSON:
- name: 2 to 4 lowercase words joined by "-" ("export-png", "morning-mail").
- description: one sentence, at most 25 words, saying what the skill does. No "This skill".
- triggers: 1 to 3 short phrases the user could say to run it ("export as png"). Lowercase, no punctuation.
- instructions: numbered steps in plain words for the assistant that runs the skill. Name the controls. Use {param} placeholders for values that change between runs. No coordinates.
- params: values that should change between runs (a file name, a recipient, a search term). For each: name (lowercase letters and _), description (a few words), and value: the exact text used in this run, or "" when there was none. Use [] when nothing should change.

Rules:
- Only describe steps that ran or were recorded. Never add new ones.
- Never put passwords or other secrets in the instructions or params.`

export function authoringTurn(request: string, steps: string, declared: string[] = []): string {
  return [
    `Request: ${request || '(none given)'}`,
    '',
    'Steps:',
    steps,
    ...(declared.length
      ? [
          '',
          `These placeholders already exist; use them: ${declared.map((d) => `{${d}}`).join(', ')}.`
        ]
      : [])
  ].join('\n')
}

// ---- names and text ----

/** "Export as PNG!" → "export-as-png" (≤ 40 chars); "" when nothing is left. */
export function slugName(text: string, max = 40): string {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > max) break
    out = next
  }
  return out
}

/** `base`, else `base-2`, `base-3` … until `taken` says no. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  const root = SKILL_NAME_RE.test(base) ? base : 'my-skill'
  if (!taken(root)) return root
  for (let i = 2; i < 100; i++) {
    const n = `${root.slice(0, 60)}-${i}`
    if (!taken(n)) return n
  }
  return `${root.slice(0, 50)}-${Date.now().toString(36)}`
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

const PARAM_RE = /^[a-z_][a-z0-9_]{0,31}$/

/** "File name" → "file_name"; unique within `taken`. */
export function paramName(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'v_$1')
      .slice(0, 24) || 'value'
  let n = base
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
  taken.add(n)
  return n
}

/** The model's words, cleaned up, as a draft (fallbacks for anything unusable). */
export function draftFromText(
  text: AuthoringText | null,
  base: {
    fallbackName: string
    fallbackDescription: string
    fallbackInstructions: string
    triggers?: string[]
    params?: DraftParam[]
    permissions: SkillDraft['permissions']
    steps?: SkillStep[] | null
    source: SkillDraft['source']
  }
): SkillDraft {
  const name = slugName(text?.name ?? '') || slugName(base.fallbackName) || 'my-skill'
  const description =
    oneLine(text?.description ?? '', 200) || oneLine(base.fallbackDescription, 200)
  const triggers = [...(text?.triggers ?? []), ...(base.triggers ?? [])]
    .map((t) => oneLine(t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' '), 80))
    .filter((t) => t.length >= 2)
  const params = new Map<string, DraftParam>()
  for (const p of base.params ?? []) params.set(p.name, p)
  for (const p of text?.params ?? []) {
    const n = p.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!PARAM_RE.test(n) || params.size >= 20) continue
    const prev = params.get(n)
    params.set(n, {
      name: n,
      ...(oneLine(p.description, 200) ? { description: oneLine(p.description, 200) } : {}),
      ...((prev?.value ?? p.value) ? { value: prev?.value ?? p.value } : {})
    })
  }
  const list = [...params.values()]
  const steps = base.steps ? withPlaceholders(base.steps, list) : null
  const instructions = (text?.instructions ?? '').trim().slice(0, 6000) || base.fallbackInstructions
  return {
    name,
    description,
    triggers: [...new Set(triggers)].slice(0, 5),
    params: list,
    instructions,
    permissions: base.permissions,
    ...(steps?.length ? { steps: stepsFileSchema.parse({ version: 1, steps }) } : {}),
    source: base.source
  }
}

// ---- "when I say X, do Y" ----

const WHEN_RE =
  /^(?:(?:please\s+)?(?:create|make|add|new)\s+(?:a\s+)?(?:new\s+)?skill\s*[:,-]?\s*)?when(?:ever)?\s+i\s+say\s+["“'‘]?(.+?)["”'’]?\s*(?:,|;|:|\s-\s|\bthen\b|\byou should\b|\bi want you to\b|\bplease\b|\bdo\b|\byou\b)\s*(.+)$/i

/** "When I say morning, open my mail and read today's events" → { phrase, action }. */
export function matchWhenISay(utterance: string): { phrase: string; action: string } | null {
  const m = WHEN_RE.exec(utterance.trim())
  if (!m) return null
  const phrase = oneLine(m[1].toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' '), 80)
  const action = oneLine(
    m[2].replace(/^(?:then|please|you should|do|lumen)\s+/i, '').replace(/[.!]+$/, ''),
    600
  )
  const words = phrase.split(' ').filter(Boolean).length
  if (phrase.length < 2 || words > 8 || action.length < 3) return null
  return { phrase, action }
}

/** The action split into steps: "open my mail and then read the events" → two steps. */
export function actionSteps(action: string): string[] {
  return action
    .split(/\s*(?:,\s*(?:and\s+)?then\s+|\s+and then\s+|\s+then\s+|\s+after that\s+|;\s*)/i)
    .map((s) => s.trim().replace(/^and\s+/i, ''))
    .filter((s) => s.length >= 2)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .slice(0, 12)
}

/** A draft for "when I say X, do Y" (no model call). */
export function draftFromVoice(phrase: string, action: string): SkillDraft {
  const steps = actionSteps(action)
  const said = action.charAt(0).toUpperCase() + action.slice(1)
  return {
    name: slugName(phrase) || 'my-skill',
    description: oneLine(said, 200),
    triggers: [phrase],
    params: [],
    instructions: [
      `The user said “${phrase}”. Do this:`,
      '',
      ...steps.map((s, i) => `${i + 1}. ${s.replace(/[.]?$/, '.')}`),
      '',
      'If a step is unclear, ask the user one short question instead of guessing.'
    ].join('\n'),
    permissions: { input: true, network: [] },
    source: 'voice'
  }
}

// ---- watch-me recordings ----

/**
 * steps.json from a recording's steps: clicks, selections, focus moves and shortcuts as they
 * were; text typed into a field (never recorded) becomes a parameter asked for at run time.
 */
export function skeletonToSteps(steps: readonly SkeletonStep[]): {
  steps: SkillStep[]
  params: DraftParam[]
} {
  const out: SkillStep[] = []
  const params: DraftParam[] = []
  const names = new Set<string>()
  for (const s of steps) {
    const target: ElementMatch | null =
      s.name || s.automationId
        ? {
            ...(s.name ? { name: s.name } : {}),
            ...(s.role ? { role: s.role } : {}),
            ...(s.automationId ? { automationId: s.automationId } : {})
          }
        : null
    switch (s.kind) {
      case 'key': {
        const combo = (s.combo ?? '').toLowerCase().replace(/\s+/g, '')
        if (COMBO_RE.test(combo)) out.push({ do: 'keys', combo })
        break
      }
      case 'invoked':
        if (target) out.push({ do: 'invoke', target })
        break
      case 'selected':
        if (target) out.push({ do: 'select', target })
        break
      case 'focused':
        if (target) out.push({ do: 'focus', target })
        break
      case 'text': {
        if (!target) break
        const name = paramName(s.name ?? s.automationId ?? 'text', names)
        params.push({ name, description: `what to type in ${s.name ?? 'the field'}` })
        out.push({ do: 'set_value', target, value: `{${name}}` })
        break
      }
    }
  }
  return { steps: out, params }
}

// ---- SKILL.md ----

const yamlString = (s: string): string => JSON.stringify(s)

/** The SKILL.md text of a draft. It always parses (checked by the caller with parseSkillFile). */
export function renderSkillMd(d: SkillDraft): string {
  const lines = [
    '---',
    `name: ${d.name}`,
    `description: ${yamlString(d.description)}`,
    ...(d.whenToUse ? [`when_to_use: ${yamlString(d.whenToUse)}`] : []),
    'version: 1.0.0',
    ...(d.apps?.length ? [`apps: [${d.apps.join(', ')}]`] : []),
    `triggers: [${d.triggers.map(yamlString).join(', ')}]`
  ]
  if (d.params.length) {
    lines.push('params:')
    for (const p of d.params) {
      lines.push(`  ${p.name}:`, '    type: string')
      if (p.description) lines.push(`    description: ${yamlString(p.description)}`)
    }
  }
  lines.push('permissions:', `  input: ${d.permissions.input}`)
  if (d.permissions.network.length)
    lines.push(`  network: [${d.permissions.network.map(yamlString).join(', ')}]`)
  if (d.permissions.profile) lines.push('  profile: true')
  if (d.permissions.connectors?.length)
    lines.push(`  connectors: [${d.permissions.connectors.join(', ')}]`)
  if (d.tools?.length) lines.push(`tools: [${d.tools.join(', ')}]`)
  lines.push('---', d.instructions.trim(), '')
  return lines.join('\n')
}

/** The draft as files, validated; throws with a readable reason. */
export function draftFiles(d: SkillDraft): {
  skillMd: string
  stepsJson?: string
  extra?: DraftFile[]
} {
  const skillMd = renderSkillMd(d)
  parseSkillFile(skillMd)
  return {
    skillMd,
    ...(d.steps ? { stepsJson: `${JSON.stringify(d.steps, null, 2)}\n` } : {}),
    ...(d.references?.length ? { extra: d.references } : {})
  }
}

/** The draft read out loud. */
export function readBack(d: SkillDraft): string {
  const say = d.triggers.length ? ` Say “${d.triggers[0]}” to run it.` : ''
  const steps = d.steps
    ? ` It has ${d.steps.steps.length} recorded steps that run without the AI.`
    : ''
  const params = d.params.length
    ? ` It asks for ${d.params.map((p) => p.name.replace(/_/g, ' ')).join(', ')}.`
    : ''
  return `${d.name.replace(/-/g, ' ')}: ${d.description}${say}${steps}${params}`
}

// ---- voice ----

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:ok|okay|hey lumen|lumen|please)\s+/, '')
    .replace(/\s+please$/, '')
    .trim()

export type CreateIntent =
  | { kind: 'save-last'; name?: string }
  | { kind: 'when'; phrase: string; action: string }
  | { kind: 'record'; title?: string }

const SAVE_LAST_RE =
  /^(?:save|keep|remember|store|make|turn) (?:that|this|it|what you (?:just )?did) (?:as|into) (?:a |an )?(?:new )?skill(?: (?:called|named) (.+))?$/
const RECORD_RE =
  /^(?:(?:watch me|record me|record my steps|learn from me)(?: and| to)? (?:make|create|build|learn|teach you) (?:a |an )?(?:new )?skill|record (?:a |an )?(?:new )?skill|teach you (?:a |an )?(?:new )?skill)(?: (?:to|for|that|called|named|about|on how to|how to) (.+))?$/

/** Starts a draft: "save that as a skill", "when I say X, do Y", "watch me make a skill". */
export function matchCreateIntent(utterance: string): CreateIntent | null {
  if (!utterance || utterance.length > 400) return null
  const when = matchWhenISay(utterance)
  if (when) return { kind: 'when', ...when }
  const n = norm(utterance)
  const save = SAVE_LAST_RE.exec(n)
  if (save) return { kind: 'save-last', ...(save[1] ? { name: save[1] } : {}) }
  const rec = RECORD_RE.exec(n)
  if (rec) return { kind: 'record', ...(rec[1] ? { title: rec[1] } : {}) }
  return null
}

export type DraftCommand =
  | { cmd: 'save'; name?: string }
  | { cmd: 'yes' }
  | { cmd: 'rename'; name: string }
  | { cmd: 'trigger'; phrase: string }
  | { cmd: 'read' }
  | { cmd: 'discard' }

/** Review of a waiting draft by voice. */
export function matchDraftCommand(utterance: string): DraftCommand | null {
  const n = norm(utterance)
  if (!n || n.length > 120) return null
  if (/^(?:yes|yes save it|yeah|yep|sure|do it)$/.test(n)) return { cmd: 'yes' }
  if (/^(?:save|keep)(?: it| that| the skill| this skill)?$/.test(n)) return { cmd: 'save' }
  let m = /^(?:save|keep) (?:it|that|the skill) as (.+)$/.exec(n)
  if (m) return { cmd: 'save', name: m[1] }
  m = /^(?:call it|name it|rename it(?: to)?|change the name to) (.+)$/.exec(n)
  if (m) return { cmd: 'rename', name: m[1] }
  m = /^(?:trigger it with|start it with|run it with|use the phrase|the phrase is) (.+)$/.exec(n)
  if (m) return { cmd: 'trigger', phrase: m[1] }
  if (/^(?:read it(?: back)?|read the skill|read it to me|what does it do)$/.test(n))
    return { cmd: 'read' }
  if (
    /^(?:no|no thanks|discard(?: it| that| the skill)?|delete it|cancel|forget it|throw it away)$/.test(
      n
    )
  )
    return { cmd: 'discard' }
  return null
}
