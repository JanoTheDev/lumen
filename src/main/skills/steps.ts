// Deterministic skill steps (11 T04, CONTRACTS C10 `steps.json`): a recorded or saved sequence
// of UI Automation actions, keys and waits that runs without the model. Targets are matched by
// element name / role / automationId in a fresh snapshot, never by coordinates, so the same
// steps work after a window moved. Values may hold {param} placeholders. Pure: no Electron, no
// fs (the runner reads the file).
import { z } from 'zod'
import type { Action, ElementNode, SkillManifest } from '@shared/types'
import { resolveParams, type SkillArgs } from './disclosure'

export const STEPS_FILE = 'steps.json'
export const MAX_SKILL_STEPS = 60
export const MAX_STEPS_FILE_BYTES = 128 * 1024

export const elementMatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(40).optional(),
    automationId: z.string().trim().min(1).max(200).optional()
  })
  .strict()
  .refine((m) => !!(m.name || m.automationId), 'a target needs a name or an automationId')

export const waitCondSchema = z
  .object({
    kind: z.enum(['window_title', 'element', 'text']),
    value: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(40).optional()
  })
  .strict()

const common = {
  /** What the step does, in words (bar, read back, the LLM fallback). */
  say: z.string().trim().min(1).max(200).optional(),
  /** Checked after the step; a miss is drift. */
  expect: waitCondSchema.optional(),
  /** How long to look for the target / wait (default 4 s, max 15 s). */
  timeoutMs: z.number().int().min(100).max(15_000).optional()
}

export const ELEMENT_OPS = [
  'invoke',
  'click',
  'double_click',
  'right_click',
  'toggle',
  'select',
  'expand',
  'focus'
] as const

export const skillStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.enum(ELEMENT_OPS), target: elementMatchSchema, ...common }).strict(),
  z
    .object({
      do: z.enum(['set_value', 'type']),
      target: elementMatchSchema.optional(),
      value: z.string().max(2000),
      ...common
    })
    .strict(),
  z
    .object({
      do: z.literal('keys'),
      combo: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[\w+-]+$/, 'a combo like "ctrl+s"'),
      ...common
    })
    .strict(),
  z
    .object({ do: z.literal('navigate'), url: z.string().trim().min(1).max(2000), ...common })
    .strict(),
  z.object({ do: z.literal('wait'), for: waitCondSchema, ...common }).strict(),
  /** Starts an app from the known-app registry (Start menu name), never a path. */
  z
    .object({ do: z.literal('launch_app'), app: z.string().trim().min(1).max(100), ...common })
    .strict()
])

export const stepsFileSchema = z.object({
  version: z.literal(1).default(1),
  /** App-pack id or process name the steps were recorded in (information only). */
  app: z.string().max(64).optional(),
  steps: z.array(skillStepSchema).min(1).max(MAX_SKILL_STEPS)
})

export type ElementMatch = z.infer<typeof elementMatchSchema>
export type WaitCond = z.infer<typeof waitCondSchema>
export type SkillStep = z.infer<typeof skillStepSchema>
export type StepsFile = z.infer<typeof stepsFileSchema>

export class StepsFileError extends Error {}

/** Parses a steps.json text. Throws StepsFileError with a readable reason. */
export function parseStepsFile(text: string): StepsFile {
  if (text.length > MAX_STEPS_FILE_BYTES) throw new StepsFileError('steps.json is too large')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new StepsFileError('steps.json is not valid JSON')
  }
  const r = stepsFileSchema.safeParse(data)
  if (!r.success)
    throw new StepsFileError(
      r.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || 'file'}: ${i.message}`)
        .join('; ')
    )
  return r.data
}

const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g

/** The step's strings that may hold placeholders. */
function stepStrings(s: SkillStep): string[] {
  const out: string[] = []
  if ('value' in s) out.push(s.value)
  if (s.do === 'navigate') out.push(s.url)
  if ('target' in s && s.target?.name) out.push(s.target.name)
  if (s.do === 'wait') out.push(s.for.value)
  if (s.expect) out.push(s.expect.value)
  return out
}

/** Placeholder names the steps use, in order of first use. */
export function usedParams(steps: readonly SkillStep[]): string[] {
  const seen = new Set<string>()
  for (const s of steps)
    for (const str of stepStrings(s)) for (const m of str.matchAll(PLACEHOLDER_RE)) seen.add(m[1])
  return [...seen]
}

export interface FilledSteps {
  steps: SkillStep[]
  /** Declared params the steps use that have no value yet (ask the user). */
  missing: string[]
  /** Bad values, or placeholders that are not declared params. */
  problems: string[]
}

/** The steps with every used {param} filled from the arguments or defaults. */
export function fillStepParams(
  steps: readonly SkillStep[],
  m: SkillManifest,
  args?: SkillArgs
): FilledSteps {
  const { values, missing, problems } = resolveParams(m, args)
  const used = usedParams(steps)
  const undeclared = used.filter((p) => !(p in m.params))
  const out: FilledSteps = {
    steps: [],
    missing: missing.filter((p) => used.includes(p)),
    problems: [...problems, ...undeclared.map((p) => `{${p}} is not a declared parameter`)]
  }
  if (out.missing.length || out.problems.length) return out
  const sub = (s: string, encode = false): string =>
    s.replace(PLACEHOLDER_RE, (all, key: string) =>
      key in values ? (encode ? encodeURIComponent(values[key]) : values[key]) : all
    )
  out.steps = steps.map((s): SkillStep => {
    const next = { ...s } as SkillStep
    if ('value' in next) next.value = sub(next.value)
    if (next.do === 'navigate') next.url = sub(next.url, true)
    if ('target' in next && next.target?.name)
      next.target = { ...next.target, name: sub(next.target.name) }
    if (next.do === 'wait') next.for = { ...next.for, value: sub(next.for.value) }
    if (next.expect) next.expect = { ...next.expect, value: sub(next.expect.value) }
    return next
  })
  return out
}

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * The element a step means: automationId first (with the role when given), then the exact name
 * and role, then the exact name in any role. Visible, enabled elements win over hidden ones.
 */
export function findElement(nodes: readonly ElementNode[], m: ElementMatch): ElementNode | null {
  const visible = (n: ElementNode): boolean => n.rect.w > 0 && n.rect.h > 0
  const rank = (list: ElementNode[]): ElementNode | null =>
    list.find((n) => visible(n) && n.enabled) ?? list.find(visible) ?? list[0] ?? null
  const role = norm(m.role)
  const roleOk = (n: ElementNode): boolean => !role || norm(n.role) === role
  if (m.automationId) {
    const hit = rank(nodes.filter((n) => n.automationId === m.automationId && roleOk(n)))
    if (hit) return hit
  }
  if (!m.name) return null
  const name = norm(m.name)
  return (
    rank(nodes.filter((n) => norm(n.name) === name && roleOk(n))) ??
    rank(nodes.filter((n) => norm(n.name) === name))
  )
}

const center = (el: ElementNode): { x: number; y: number } => ({
  x: Math.round(el.rect.x + el.rect.w / 2),
  y: Math.round(el.rect.y + el.rect.h / 2)
})

/** Rich text (documents): ValuePattern would drop formatting, so text is typed there. */
const richText = (el: ElementNode): boolean => /^(document|pane|custom)$/i.test(el.role)

/** The executor actions for one step on its resolved element (physical px). launch_app and
 * wait have none: the runner starts apps through its own port. */
export function stepActions(step: SkillStep, el: ElementNode | null): Action[] {
  const click = (button: 'left' | 'right', count = 1): Action[] =>
    el
      ? [
          {
            type: 'input',
            steps: [{ t: 'click', button, ...center(el), ...(count > 1 ? { count } : {}) }]
          }
        ]
      : []
  const uia = (action: 'invoke' | 'toggle' | 'select' | 'expand' | 'focus'): Action[] =>
    el ? [{ type: 'uia_act', elementId: el.id, action, description: el.name }] : []
  switch (step.do) {
    case 'click':
      return click('left')
    case 'right_click':
      return click('right')
    case 'double_click':
      return click('left', 2)
    case 'focus':
      return uia('focus')
    case 'invoke':
    case 'toggle':
    case 'select':
    case 'expand': {
      const pattern = step.do === 'invoke' ? 'invoke' : step.do
      return el?.patterns.includes(pattern) ? uia(step.do) : click('left')
    }
    case 'set_value':
    case 'type': {
      const text: Action = { type: 'type', text: step.value }
      if (!el)
        return step.do === 'set_value' ? [{ type: 'hotkey', keys: ['ctrl', 'a'] }, text] : [text]
      if (step.do === 'set_value' && el.patterns.includes('value') && !richText(el))
        return [
          {
            type: 'uia_act',
            elementId: el.id,
            action: 'set_value',
            value: step.value,
            description: el.name
          }
        ]
      return [
        { type: 'uia_act', elementId: el.id, action: 'focus', description: el.name },
        ...(step.do === 'set_value' ? [{ type: 'hotkey' as const, keys: ['ctrl', 'a'] }] : []),
        text
      ]
    }
    case 'keys':
      return [
        {
          type: 'hotkey',
          keys: step.combo
            .split('+')
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean)
        }
      ]
    case 'navigate':
      return [{ type: 'navigate_url', url: step.url }]
    case 'wait':
    case 'launch_app':
      return []
  }
}

const q = (s: string | undefined): string => `“${s ?? 'it'}”`

/** The step in words ("Click “Export”", "Press ctrl+s"). */
export function describeSkillStep(s: SkillStep): string {
  if (s.say) return s.say
  const el = 'target' in s && s.target ? q(s.target.name ?? s.target.automationId) : ''
  switch (s.do) {
    case 'click':
    case 'invoke':
      return `Click ${el}`
    case 'double_click':
      return `Double-click ${el}`
    case 'right_click':
      return `Right-click ${el}`
    case 'toggle':
      return `Switch ${el}`
    case 'select':
      return `Select ${el}`
    case 'expand':
      return `Open ${el}`
    case 'focus':
      return `Go to ${el}`
    case 'set_value':
    case 'type':
      return el ? `Type ${q(s.value)} into ${el}` : `Type ${q(s.value)}`
    case 'keys':
      return `Press ${s.combo}`
    case 'navigate':
      return `Open ${s.url}`
    case 'wait':
      return `Wait for ${q(s.for.value)}`
    case 'launch_app':
      return `Start ${s.app}`
  }
}

/** Steps that use the real mouse and keyboard (all but waits). */
export function needsInput(steps: readonly SkillStep[]): boolean {
  return steps.some((s) => s.do !== 'wait')
}
