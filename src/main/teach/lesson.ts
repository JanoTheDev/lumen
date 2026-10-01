// Lesson data (CONTRACTS C9, plans 07 lesson-engine.md) and the loader that turns a stored
// lesson into the engine's shape. Pure: no Electron, no fs.
import { z } from 'zod'

export interface ElementMatch {
  name?: string
  role?: string
  automationId?: string
  nth?: number
}

export type LessonTarget =
  | { element: ElementMatch }
  | { text: string; nth?: number }
  | { region: string }
  | { shortcut: string }
  | { mark: number }
  | { point: { x: number; y: number } }

export type ValueMatch = string | { regex: string }

export type UiaEventKind = 'invoked' | 'focused' | 'value' | 'selected' | 'window-opened'

export type CheckSpec =
  | {
      type: 'uia-event'
      event: UiaEventKind
      match: { name?: string; role?: string; automationId?: string; value?: ValueMatch }
    }
  | { type: 'window-title'; regex: string }
  | { type: 'vision'; prompt: string }
  | { type: 'bridge'; app: string; expect: Record<string, unknown> }
  | { type: 'keypress'; combo: string }
  | { type: 'manual' }
  | { type: 'anyOf' | 'allOf'; checks: CheckSpec[] }

/** "Do it for me" actions: C2 input steps by region, plus open_url and invoke by element. */
export type DoAction =
  | { t: 'keys'; combo: string }
  | { t: 'type'; text: string }
  | { t: 'move'; region: string }
  | { t: 'click'; button?: 'left' | 'right' | 'middle'; count?: number; region?: string }
  | { t: 'scroll'; dx: number; dy: number; region?: string }
  | { t: 'wait'; ms: number }
  | { t: 'open_url'; url: string }
  | { t: 'invoke'; element: ElementMatch }

export interface LessonStep {
  id: string
  say: string
  target: LessonTarget | null
  /** Normalized from the stored `expect`; no expect = manual. */
  check: CheckSpec
  hints: string[]
  why?: string
  doItForMe?: { actions: DoAction[] }
  timeoutSec?: number
}

export interface Lesson {
  id: string
  app: string
  title: string
  level: 'beginner' | 'intermediate' | 'advanced'
  minutes: number
  prereqs: string[]
  appVersion: string
  summary?: string
  tags?: string[]
  steps: LessonStep[]
}

// ---- Stored format (validated at load; scripts/validate-skills.mjs does the full lint) ----

const elementMatch = z
  .object({
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    automationId: z.string().min(1).optional(),
    nth: z.number().int().min(0).optional()
  })
  .strict()

const target = z.union([
  z.object({ element: elementMatch }).strict(),
  z.object({ text: z.string().min(1), nth: z.number().int().min(0).optional() }).strict(),
  z.object({ region: z.string().min(1) }).strict(),
  z.object({ shortcut: z.string().min(1) }).strict(),
  z.object({ mark: z.number().int().min(0) }).strict(),
  z.object({ point: z.object({ x: z.number(), y: z.number() }).strict() }).strict()
])

const valueMatch = z.union([z.string(), z.object({ regex: z.string().min(1) }).strict()])

export const checkSchema: z.ZodType<CheckSpec> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal('uia-event'),
        event: z.enum(['invoked', 'focused', 'value', 'selected', 'window-opened']),
        match: z
          .object({
            name: z.string().optional(),
            role: z.string().optional(),
            automationId: z.string().optional(),
            value: valueMatch.optional()
          })
          .strict()
      })
      .strict(),
    z.object({ type: z.literal('window-title'), regex: z.string().min(1) }).strict(),
    z.object({ type: z.literal('vision'), prompt: z.string().min(3) }).strict(),
    z
      .object({
        type: z.literal('bridge'),
        app: z.string().min(1),
        expect: z.record(z.string(), z.unknown())
      })
      .strict(),
    z.object({ type: z.literal('keypress'), combo: z.string().min(1) }).strict(),
    z.object({ type: z.literal('manual') }).strict(),
    z.object({ type: z.enum(['anyOf', 'allOf']), checks: z.array(checkSchema).min(1) }).strict()
  ])
)

const CHECK_NAMES = ['uia-event', 'window-title', 'vision', 'bridge', 'keypress', 'manual'] as const

const expectSchema = z
  .object({
    type: z.literal('user-action').optional(),
    check: z.union([z.enum(CHECK_NAMES), checkSchema]),
    prompt: z.string().min(3).optional()
  })
  .strict()

const action = z.union([
  z.object({ t: z.literal('keys'), combo: z.string().min(1) }).strict(),
  z.object({ t: z.literal('type'), text: z.string() }).strict(),
  z.object({ t: z.literal('move'), region: z.string().min(1) }).strict(),
  z
    .object({
      t: z.literal('click'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      count: z.number().int().min(1).max(3).optional(),
      region: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      t: z.literal('scroll'),
      dx: z.number().int(),
      dy: z.number().int(),
      region: z.string().min(1).optional()
    })
    .strict(),
  z.object({ t: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }).strict(),
  z
    .object({ t: z.literal('open_url'), url: z.string().regex(/^(https:\/\/|ms-settings:)/) })
    .strict(),
  z.object({ t: z.literal('invoke'), element: elementMatch }).strict()
])

const storedStep = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    say: z.string().min(3).max(200),
    target: target.nullable().optional(),
    expect: expectSchema.optional(),
    hints: z.array(z.string().min(3).max(240)).max(3).default([]),
    why: z.string().max(200).optional(),
    doItForMe: z
      .object({ actions: z.array(action).min(1) })
      .strict()
      .optional(),
    timeoutSec: z.number().int().min(10).max(900).optional()
  })
  .strict()

export const storedLessonSchema = z
  .object({
    $schema: z.string().optional(),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    app: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().min(3).max(80),
    summary: z.string().max(200).optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced']),
    minutes: z.number().int().min(1).max(60),
    prereqs: z.array(z.string()).default([]),
    appVersion: z.string().min(1),
    tags: z.array(z.string()).optional(),
    steps: z.array(storedStep).min(1).max(50)
  })
  .strict()

export type StoredLesson = z.input<typeof storedLessonSchema>
type StoredStep = z.output<typeof storedStep>

/** A short yes/no question for a step whose vision check has no prompt of its own. */
export function derivedVisionPrompt(say: string): string {
  return `Did the user complete this step: ${say}`
}

/** The stored `expect` as a full CheckSpec (C9 allows a bare check name). */
export function normalizeCheck(step: Pick<StoredStep, 'say' | 'target' | 'expect'>): CheckSpec {
  const e = step.expect
  if (!e) return { type: 'manual' }
  if (typeof e.check === 'object') return withVisionPrompts(e.check, step.say)
  const t = step.target
  switch (e.check) {
    case 'vision':
      return { type: 'vision', prompt: e.prompt ?? derivedVisionPrompt(step.say) }
    case 'keypress':
      return t && 'shortcut' in t ? { type: 'keypress', combo: t.shortcut } : { type: 'manual' }
    case 'uia-event':
      return t && 'element' in t
        ? { type: 'uia-event', event: 'invoked', match: elementOnly(t.element) }
        : { type: 'manual' }
    // A bare window-title / bridge check has nothing to match against.
    default:
      return { type: 'manual' }
  }
}

function elementOnly(e: ElementMatch): { name?: string; role?: string; automationId?: string } {
  const out: { name?: string; role?: string; automationId?: string } = {}
  if (e.name) out.name = e.name
  if (e.role) out.role = e.role
  if (e.automationId) out.automationId = e.automationId
  return out
}

function withVisionPrompts(c: CheckSpec, say: string): CheckSpec {
  if (c.type === 'vision' && !c.prompt.trim()) return { ...c, prompt: derivedVisionPrompt(say) }
  if (c.type === 'anyOf' || c.type === 'allOf')
    return { ...c, checks: c.checks.map((x) => withVisionPrompts(x, say)) }
  return c
}

/** Parses a stored lesson; throws a ZodError with paths when it is malformed. */
export function parseLesson(raw: unknown): Lesson {
  const l = storedLessonSchema.parse(raw)
  return {
    id: l.id,
    app: l.app,
    title: l.title,
    level: l.level,
    minutes: l.minutes,
    prereqs: l.prereqs,
    appVersion: l.appVersion,
    ...(l.summary ? { summary: l.summary } : {}),
    ...(l.tags ? { tags: l.tags } : {}),
    steps: l.steps.map((s) => ({
      id: s.id,
      say: s.say,
      target: s.target ?? null,
      check: normalizeCheck(s),
      hints: s.hints,
      ...(s.why ? { why: s.why } : {}),
      ...(s.doItForMe ? { doItForMe: s.doItForMe } : {}),
      ...(s.timeoutSec ? { timeoutSec: s.timeoutSec } : {})
    }))
  }
}

/** Every check type a spec uses (combinators expanded). */
export function checkTypes(c: CheckSpec, out = new Set<CheckSpec['type']>()): Set<string> {
  out.add(c.type)
  if (c.type === 'anyOf' || c.type === 'allOf') for (const x of c.checks) checkTypes(x, out)
  return out
}
