// "Show me how" (plans 07 T18): a how-to question becomes a lesson made on the spot from the
// screen, the app's skill pack and the UIA elements list, and runs through the same engine as
// pack lessons. The model fills a flat schema (structured outputs reject recursive unions and
// numeric bounds); toLesson() turns it into a C9 lesson: element ids become name/role matches,
// unknown regions and bad regexes are dropped, and every machine check gets a vision fallback.
// No Electron: the model call comes in through `complete`.
import { z } from 'zod'
import type { ElementNode } from '@shared/types'
import type { SkillPack } from '../ai/skills'
import { LESSON_PROMPT, lessonTurn, type LessonTurnInput } from '../ai/prompts/lesson'
import {
  derivedVisionPrompt,
  parseLesson,
  slug,
  type CheckSpec,
  type Lesson,
  type LessonTarget,
  type StoredLesson,
  type UiaEventKind
} from './lesson'

const TARGET_KINDS = ['element', 'text', 'region', 'shortcut', 'none'] as const
const CHECK_KINDS = ['uia-event', 'window-title', 'keypress', 'vision', 'manual'] as const
const EVENTS = ['invoked', 'focused', 'selected', 'value', 'window-opened'] as const

// Every field required ("" = unused): the same schema works for both providers' strict modes.
export const genLessonSchema = z.object({
  title: z.string(),
  minutes: z.number(),
  steps: z.array(
    z.object({
      say: z.string(),
      why: z.string(),
      hints: z.array(z.string()),
      target: z.object({
        kind: z.enum(TARGET_KINDS),
        elementId: z.string(),
        name: z.string(),
        role: z.string(),
        text: z.string(),
        region: z.string(),
        shortcut: z.string()
      }),
      check: z.object({
        kind: z.enum(CHECK_KINDS),
        event: z.enum(EVENTS),
        name: z.string(),
        role: z.string(),
        value: z.string(),
        titleRegex: z.string(),
        question: z.string()
      })
    })
  )
})

export type GenLesson = z.infer<typeof genLessonSchema>
type GenStep = GenLesson['steps'][number]

export const MAX_STEPS = 8
const BANNED = /\b(simply|just|obviously)\s+/gi

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

function clip(s: string, max: number): string {
  const t = clean(s)
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Spoken text: no "just"/"simply", no markdown. */
export function spoken(s: string, max: number): string {
  const t = clip(s.replace(BANNED, '').replace(/[*_`#]/g, ''), max)
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export interface ToLessonContext {
  appId: string
  question: string
  /** UIA nodes by id (the elements list the model saw). */
  elements?: Map<string, ElementNode>
  regions?: Record<string, unknown>
  /** No usable UIA: uia-event checks become vision checks. */
  uiaNone?: boolean
}

function toTarget(t: GenStep['target'], ctx: ToLessonContext): LessonTarget | null {
  switch (t.kind) {
    case 'element': {
      const node = t.elementId ? ctx.elements?.get(clean(t.elementId)) : undefined
      const name = clean(node?.name) || clean(t.name)
      const role = clean(node?.role) || clean(t.role)
      if (name) return { element: { name: clip(name, 80), ...(role ? { role } : {}) } }
      if (node?.automationId) return { element: { automationId: node.automationId } }
      return clean(t.text) ? { text: clip(t.text, 60) } : null
    }
    case 'text':
      return clean(t.text) ? { text: clip(t.text, 60) } : null
    case 'region':
      return ctx.regions && clean(t.region) in ctx.regions ? { region: clean(t.region) } : null
    case 'shortcut':
      return /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(clean(t.shortcut).replace(/\s*\+\s*/g, '+'))
        ? { shortcut: clean(t.shortcut).replace(/\s*\+\s*/g, '+') }
        : null
    default:
      return null
  }
}

function validRegex(s: string): boolean {
  if (!s || s.length > 120) return false
  try {
    new RegExp(s, 'i')
    return true
  } catch {
    return false
  }
}

function toCheck(
  c: GenStep['check'],
  say: string,
  target: LessonTarget | null,
  ctx: ToLessonContext
): CheckSpec {
  const question = clean(c.question)
  const vision: CheckSpec = {
    type: 'vision',
    prompt: question.length >= 3 ? clip(question, 300) : derivedVisionPrompt(say)
  }
  const withVision = (primary: CheckSpec | null): CheckSpec =>
    primary ? { type: 'anyOf', checks: [primary, vision] } : vision
  const el = target && 'element' in target ? target.element : null
  switch (c.kind) {
    case 'manual':
      return { type: 'manual' }
    case 'vision':
      return vision
    case 'window-title':
      return withVision(
        validRegex(clean(c.titleRegex))
          ? { type: 'window-title', regex: clean(c.titleRegex) }
          : null
      )
    case 'keypress': {
      const combo = target && 'shortcut' in target ? target.shortcut : clean(c.name)
      return withVision(combo ? { type: 'keypress', combo } : null)
    }
    case 'uia-event': {
      if (ctx.uiaNone) return vision
      const name = clean(c.name) || el?.name
      const role = clean(c.role) || el?.role
      if (!name) return vision
      const event: UiaEventKind = c.event
      const match = {
        name: clip(name, 80),
        ...(role ? { role } : {}),
        ...(event === 'value' && clean(c.value) ? { value: clean(c.value) } : {})
      }
      return withVision({ type: 'uia-event', event, match })
    }
  }
}

/** The generated reply as a validated lesson; null when nothing usable came back. */
export function toLesson(g: GenLesson, ctx: ToLessonContext): Lesson | null {
  const used = new Set<string>()
  const steps: StoredLesson['steps'] = []
  for (const s of g.steps.slice(0, MAX_STEPS)) {
    const say = spoken(s.say, 200)
    if (say.length < 3) continue
    const target = toTarget(s.target, ctx)
    let id = `s${steps.length + 1}-${slug(say, 24)}`
    while (used.has(id)) id = `${id}-x`
    used.add(id)
    const why = spoken(s.why, 200)
    steps.push({
      id,
      say,
      target,
      expect: { type: 'user-action', check: toCheck(s.check, say, target, ctx) },
      hints: s.hints
        .map((h) => spoken(h, 240))
        .filter((h) => h.length >= 3)
        .slice(0, 3),
      ...(why.length >= 3 ? { why } : {})
    })
  }
  if (!steps.length) return null
  const title = clip(g.title, 80).length >= 3 ? clip(g.title, 80) : clip(ctx.question, 80)
  const stored: StoredLesson = {
    id: `${ctx.appId}-gen-${slug(title, 40)}`,
    app: ctx.appId,
    title: title.length >= 3 ? title : 'Your lesson',
    summary: clip(ctx.question, 200),
    level: 'beginner',
    minutes: Math.min(60, Math.max(1, Math.round(Number.isFinite(g.minutes) ? g.minutes : 3))),
    prereqs: [],
    appVersion: 'any',
    tags: ['generated'],
    steps
  }
  try {
    return parseLesson(stored)
  } catch {
    return null
  }
}

/** What the generator sees: the question and the screen context of this turn. */
export interface GenerateInput extends ToLessonContext {
  turn: LessonTurnInput
  /** Base64 screenshot of the foreground monitor. */
  image?: { data: string; mime: string }
}

export type GenerateCall = (req: {
  system: string
  user: string
  image?: { data: string; mime: string }
  signal?: AbortSignal
}) => Promise<GenLesson | null>

export async function generateLesson(
  input: GenerateInput,
  complete: GenerateCall,
  signal?: AbortSignal
): Promise<Lesson | null> {
  const raw = await complete({
    system: LESSON_PROMPT,
    user: lessonTurn(input.turn),
    image: input.image,
    signal
  })
  return raw ? toLesson(raw, input) : null
}

/** The app id for a lesson made in an app without a pack ("C:\…\notepad.exe" → "notepad"). */
export function appIdFor(
  skill: Pick<SkillPack, 'id'> | null | undefined,
  process?: string
): string {
  if (skill) return skill.id
  const base = (process ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, '')
  return slug(base || 'desktop', 30)
}
