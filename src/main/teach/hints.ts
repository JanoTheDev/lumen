// Hint escalation and scene output (plans 07 T15). Pure: the ladder timings, the hint text per
// level, the ScreenScene for a level and the assistant bar state. The buddy only ever points;
// nothing here moves the real cursor.
//
//   L0 say the step (t=0)
//   L1 buddy flies to the target and points (t=0 when a target resolves)
//   L2 hint[0] spoken, buddy points again (20s or "help")
//   L3 hint[1], highlight ring + arrow (40s)
//   L4 "Want me to do it?" (60s, step timeout, or "do it for me" anytime)
//   L5 do it, then say what was done (on yes)
import type { AssistantState } from '@shared/events'
import type { Point, Rect } from '@shared/types'
import type { DoAction, Lesson, LessonStep } from './lesson'
import type { LessonScene, ResolvedTarget } from './ports'

export const LEVEL = { SAY: 0, POINT: 1, HINT: 2, RING: 3, OFFER: 4, DO: 5 } as const

/** When each level is reached after the step starts, at pace 1. */
export const HINT_AT_MS: Record<number, number> = { 1: 0, 2: 20_000, 3: 40_000, 4: 60_000 }

export const PACES = [1, 1.5, 2] as const

/** Hint pace from the a11y timings: a longer status hold means a slower pace. */
function paceFromTimings(t: { statusHoldMs: number } | undefined): number {
  const hold = t?.statusHoldMs ?? 4000
  if (hold >= 12_000) return 2
  if (hold >= 8000) return 1.5
  return 1
}

export interface PacingInput {
  timings?: { statusHoldMs: number }
  profiles?: readonly string[]
  switch?: { enabled: boolean }
}

/**
 * Lesson pacing from the a11y config (T21): the slow-pace multiplier (status hold, or the
 * cognitive profile) and whether "do it" is offered from the start of every step (voice-only
 * and switch users).
 */
export function pacingFor(a: PacingInput): { pace: number; offerEarly: boolean } {
  const profiles = a.profiles ?? []
  const pace = Math.max(paceFromTimings(a.timings), profiles.includes('cognitive') ? 1.5 : 1)
  const offerEarly =
    !!a.switch?.enabled || profiles.includes('motor-voice') || profiles.includes('switch')
  return { pace, offerEarly }
}

export function slowerPace(p: number): number {
  return PACES.find((x) => x > p) ?? PACES[PACES.length - 1]
}

export function fasterPace(p: number): number {
  return [...PACES].reverse().find((x) => x < p) ?? PACES[0]
}

/** ms from reaching `level` to the next level's timer; null once the offer is up. */
export function nextHintDelay(level: number, pace: number): number | null {
  if (level >= LEVEL.OFFER) return null
  const from = HINT_AT_MS[Math.max(level, LEVEL.POINT)]
  const to = HINT_AT_MS[Math.max(level, LEVEL.POINT) + 1]
  return Math.round((to - from) * pace)
}

/** The first level a step starts at: L1 when there is something to point at. */
export function startLevel(step: LessonStep): number {
  return step.target ? LEVEL.POINT : LEVEL.SAY
}

/** Spoken text for a hint level, or null when the level has nothing new to say. */
export function hintText(step: LessonStep, level: number): string | null {
  if (level === LEVEL.HINT) return step.hints[0] ?? null
  if (level === LEVEL.RING) return step.hints[1] ?? step.hints[0] ?? null
  return null
}

const ARROW_LEN = 110

function center(r: Rect): Point {
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }
}

/** Arrow into the left edge of the target, or the right edge when the target hugs the left. */
function arrowTo(r: Rect): Point[] {
  const fromLeft = r.x >= ARROW_LEN + 20
  const tip = { x: fromLeft ? r.x - 6 : r.x + r.w + 6, y: Math.round(r.y + r.h / 2) }
  const tail = { x: fromLeft ? tip.x - ARROW_LEN : tip.x + ARROW_LEN, y: tip.y - 50 }
  return [tail, tip]
}

/** The scene for a step at a hint level. Shortcut targets show a key-cap label by the buddy. */
export function buildScene(step: LessonStep, level: number, r: ResolvedTarget | null): LessonScene {
  const scene: LessonScene = { highlights: [] }
  const shortcut = step.target && 'shortcut' in step.target ? step.target.shortcut : undefined
  if (shortcut) {
    if (r)
      scene.buddy = { to: r.point, label: shortcut, mode: level >= LEVEL.HINT ? 'point' : 'wait' }
    return scene
  }
  if (!r || level < LEVEL.POINT) return scene
  // Dwell users: a dwell near the target clicks the target (T21).
  if (r.rect) scene.dwellSnap = r.rect
  scene.buddy = {
    to: r.rect ? center(r.rect) : r.point,
    mode: level === LEVEL.POINT ? 'fly' : 'point'
  }
  if (level >= LEVEL.RING && r.rect) {
    scene.highlights.push({ id: 'lesson-target', rect: r.rect, style: 'ring' })
    scene.annotations = [{ kind: 'arrow', points: arrowTo(r.rect) }]
  }
  return scene
}

/** Green tick on the target the user just got right. */
export function successScene(r: ResolvedTarget | null): LessonScene | null {
  if (!r?.rect) return null
  return {
    highlights: [{ id: 'lesson-ok', rect: r.rect, style: 'success' }],
    buddy: { to: center(r.rect), mode: 'idle' }
  }
}

export const PRAISE = ['Nice.', 'Got it.', 'Well done.', 'Great.', 'That worked.']

/** Assistant bar state while a step waits for the user. */
export function stepState(
  lesson: Lesson,
  index: number,
  text: string,
  over: Partial<AssistantState> = {}
): AssistantState {
  const step = lesson.steps[index]
  return {
    phase: 'waiting-user',
    statusText: text,
    step: { index: index + 1, total: lesson.steps.length, label: step?.say ?? text },
    ...over
  }
}

export const OFFER_ACTION_ID = 'lesson-do-it'

/** At most `n` sentences of `text`, one line (model "why" answers). */
export function firstSentences(text: string, n = 2): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const parts = t.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [t]
  return parts
    .slice(0, n)
    .map((p) => p.trim())
    .join(' ')
}

/** Said when no reason is known. */
export function fallbackWhy(lesson: Lesson): string {
  return `This step is part of ${lesson.title}.`
}

/** What "do it for me" runs: the step's own actions, else one derived from its target. */
export function doItActions(step: LessonStep): DoAction[] | null {
  if (step.doItForMe?.actions.length) return step.doItForMe.actions
  const t = step.target
  if (!t) return null
  if ('element' in t) return [{ t: 'invoke', element: t.element }]
  if ('shortcut' in t) return [{ t: 'keys', combo: t.shortcut }]
  if ('region' in t) return [{ t: 'click', region: t.region }]
  return null
}

/** What "click it" / "press it" runs: the target's own click or keys (T21); null = none. */
export function performActions(step: LessonStep): DoAction[] | null {
  const t = step.target
  if (t && 'element' in t) return [{ t: 'invoke', element: t.element }]
  if (t && 'shortcut' in t) return [{ t: 'keys', combo: t.shortcut }]
  return null
}

/** The bar text for a step: the say text, plus the passive "do it" option when wanted. */
export function stepCaption(step: LessonStep, offerEarly: boolean): string {
  return offerEarly && doItActions(step) ? `${step.say} Say “do it” and I will.` : step.say
}

const KEY_WORDS: Record<string, string> = {
  win: 'Windows',
  ctrl: 'Control',
  esc: 'Escape',
  del: 'Delete'
}

function spokenCombo(combo: string): string {
  return combo
    .split('+')
    .map((k) => KEY_WORDS[k.trim().toLowerCase()] ?? k.trim())
    .join(' plus ')
}

/** One sentence about what "do it for me" did. */
export function describeDoIt(actions: DoAction[]): string {
  const a = actions.find((x) => x.t !== 'wait' && x.t !== 'move') ?? actions[0]
  switch (a?.t) {
    case 'invoke':
      return a.element.name ? `I clicked ${a.element.name} for you.` : 'I clicked it for you.'
    case 'keys':
      return `I pressed ${spokenCombo(a.combo)} for you.`
    case 'open_url':
      return a.url.startsWith('ms-settings:')
        ? 'I opened that Settings page for you.'
        : 'I opened the page for you.'
    case 'type':
      return 'I typed it for you.'
    case 'click':
      return a.region
        ? `I clicked in the ${a.region.replace(/-/g, ' ')} for you.`
        : 'I clicked for you.'
    case 'scroll':
      return 'I scrolled for you.'
    default:
      return 'I did that step for you.'
  }
}
