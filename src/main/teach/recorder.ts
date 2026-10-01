// Record my steps (plans 07 T31), the pure part: the event log of one recording and the C9
// lesson draft made from it. Privacy rules live here so they hold whatever the wiring does:
// - typed text is never kept: a value event keeps only the field's name and role ("text was
//   entered in Search"), and its value is dropped on arrival;
// - key combos are the agent's observe-only shortcuts (Ctrl / Alt / Win combos, F-keys,
//   Escape), and Lumen's own hotkey is left out;
// - events in Lumen's own windows, and while the user talks to Lumen, are dropped;
// - screenshots are taken only when the user asks for one, kept in memory for the draft call
//   and never written to disk.
// No Electron, no fs.
import {
  derivedVisionPrompt,
  parseLesson,
  slug,
  type CheckSpec,
  type ElementMatch,
  type Lesson,
  type LessonStep,
  type LessonTarget,
  type StoredLesson
} from './lesson'
import { spoken } from './generate'

export type RecordedKind = 'invoked' | 'selected' | 'text' | 'focused' | 'window-opened' | 'key'

export interface RecordedApp {
  id: string
  name: string
  /** Process image name, for the prompt. */
  process?: string
}

export interface RecordedEvent {
  at: number
  kind: RecordedKind
  /** Element name / role / automation id (UIA events). */
  name?: string
  role?: string
  automationId?: string
  /** Shortcut, e.g. "Ctrl+S" (key events). */
  combo?: string
  app?: RecordedApp
  /** Index into the recording's screenshots, when the user asked for one at this step. */
  shot?: number
}

/** A raw agent event as the wiring hands it over. */
export interface RawUiaEvent {
  kind: string
  element: { name?: string; role?: string; automationId?: string; value?: string }
}

export const MAX_EVENTS = 200
export const MAX_STEPS = 40
export const MAX_SHOTS = 4
/** Repeats of the same event closer than this are one event. */
const REPEAT_MS = 600
/** A focus event this close before an action on the same element is part of that action. */
const FOCUS_MERGE_MS = 1500
/** Focus that moves on this fast was passing through (tabbing, a page loading). */
const FOCUS_PASS_MS = 350

const KINDS: Record<string, RecordedKind> = {
  invoked: 'invoked',
  selected: 'selected',
  value: 'text',
  focused: 'focused',
  'window-opened': 'window-opened'
}

const clean = (s: string | undefined): string | undefined => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 80) : undefined
}

const LUMEN_RE = /\blumen\b/i

/** Normalizes "ctrl + shift + s" style combos to "Ctrl+Shift+S". */
export function normalizeCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('+')
}

type Identity = Pick<RecordedEvent, 'name' | 'role' | 'automationId'>
const sameElement = (a: Identity, b: Identity): boolean =>
  a.name === b.name && a.role === b.role && a.automationId === b.automationId

/** One recording's event log. */
export class Recording {
  readonly events: RecordedEvent[] = []
  readonly shots: { data: string; mime: string }[] = []
  private held = false
  private pendingShot: number | null = null

  constructor(
    readonly startedAt: number,
    private readonly opts: { hotkey?: string; title?: string } = {}
  ) {}

  get title(): string | undefined {
    return this.opts.title
  }

  /** While true (the user is talking to Lumen) nothing is recorded. */
  hold(on: boolean): void {
    this.held = on
  }

  full(): boolean {
    return this.events.length >= MAX_EVENTS
  }

  /** A UIA event from the agent; false when it was dropped. */
  uia(e: RawUiaEvent, at: number, app?: RecordedApp): boolean {
    const kind = KINDS[e.kind]
    if (!kind) return false
    // Only the element's identity is kept: never its value (typed text).
    const name = clean(e.element.name)
    const role = clean(e.element.role)
    const automationId = clean(e.element.automationId)
    if (!name && !automationId) return false
    if (kind === 'window-opened' && name && LUMEN_RE.test(name)) return false
    return this.push({
      at,
      kind,
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
      ...(automationId ? { automationId } : {}),
      ...(app ? { app } : {})
    })
  }

  /** An observe-only key combo from the agent; false when it was dropped. */
  key(combo: string, at: number, app?: RecordedApp): boolean {
    const c = normalizeCombo(combo)
    if (!c || c.length > 40) return false
    if (this.opts.hotkey && c.toLowerCase() === normalizeCombo(this.opts.hotkey).toLowerCase())
      return false
    return this.push({ at, kind: 'key', combo: c, ...(app ? { app } : {}) })
  }

  /** A screenshot the user asked for; it belongs to the last step (or the next one). */
  addShot(shot: { data: string; mime: string }): boolean {
    if (this.shots.length >= MAX_SHOTS) return false
    this.shots.push(shot)
    const i = this.shots.length - 1
    const last = this.events[this.events.length - 1]
    if (last && last.shot === undefined) last.shot = i
    else this.pendingShot = i
    return true
  }

  private push(e: RecordedEvent): boolean {
    if (this.held || this.full()) return false
    if (e.app && (LUMEN_RE.test(e.app.process ?? '') || e.app.id === 'lumen')) return false
    const prev = this.events[this.events.length - 1]
    if (prev && prev.kind === e.kind && sameElement(prev, e) && prev.combo === e.combo) {
      // Typing fires a value event per key; a double event is one action.
      if (e.kind === 'text' || e.at - prev.at < REPEAT_MS) {
        prev.at = e.at
        return true
      }
    }
    if (this.pendingShot !== null) {
      e.shot = this.pendingShot
      this.pendingShot = null
    }
    this.events.push(e)
    return true
  }
}

// ---- Skeleton: events → steps ----

export interface SkeletonStep {
  kind: Exclude<RecordedKind, 'window-opened'>
  name?: string
  role?: string
  automationId?: string
  combo?: string
  app?: RecordedApp
  shot?: number
  /** Windows that opened right after this step (prompt context only). */
  opened: string[]
}

/**
 * The steps a recording shows: one per action. Window-opened events are context for the step
 * before them; a focus event is dropped when an action on the same element follows within a
 * moment, or when focus moved on almost at once.
 */
export function skeleton(events: RecordedEvent[]): SkeletonStep[] {
  const steps: SkeletonStep[] = []
  events.forEach((e, i) => {
    if (e.kind === 'window-opened') {
      const last = steps[steps.length - 1]
      if (last && e.name && !last.opened.includes(e.name)) last.opened.push(e.name)
      return
    }
    if (e.kind === 'focused') {
      const next = events.slice(i + 1).find((x) => x.kind !== 'window-opened')
      if (next && next.at - e.at < FOCUS_PASS_MS && next.kind === 'focused') return
      const acted = events
        .slice(i + 1)
        .some((x) => x.kind !== 'focused' && x.at - e.at < FOCUS_MERGE_MS && sameElement(x, e))
      if (acted) return
    }
    if (steps.length >= MAX_STEPS) return
    const last = steps[steps.length - 1]
    // Focus first, then text typed into the same field: one "type in X" step.
    if (last && last.kind === 'focused' && e.kind === 'text' && sameElement(last, e)) {
      last.kind = 'text'
      if (e.shot !== undefined && last.shot === undefined) last.shot = e.shot
      return
    }
    steps.push({
      kind: e.kind,
      ...(e.name ? { name: e.name } : {}),
      ...(e.role ? { role: e.role } : {}),
      ...(e.automationId ? { automationId: e.automationId } : {}),
      ...(e.combo ? { combo: e.combo } : {}),
      ...(e.app ? { app: e.app } : {}),
      ...(e.shot !== undefined ? { shot: e.shot } : {}),
      opened: []
    })
  })
  return steps
}

/** The app most steps happened in (ties: the first one seen). */
export function mainApp(steps: SkeletonStep[]): RecordedApp | null {
  const count = new Map<string, { app: RecordedApp; n: number }>()
  for (const s of steps) {
    if (!s.app) continue
    const c = count.get(s.app.id) ?? { app: s.app, n: 0 }
    c.n++
    count.set(s.app.id, c)
  }
  let best: { app: RecordedApp; n: number } | null = null
  for (const c of count.values()) if (!best || c.n > best.n) best = c
  return best?.app ?? null
}

const q = (s: string | undefined): string => `“${s ?? 'it'}”`

/** The step as one line for the model. */
export function describeStep(s: SkeletonStep, i: number): string {
  const el = `${s.role ? `${s.role} ` : ''}${q(s.name ?? s.automationId)}`
  const what: Record<SkeletonStep['kind'], string> = {
    invoked: `clicked ${el}`,
    selected: `selected ${el}`,
    text: `typed into ${el} (the text itself was not recorded)`,
    focused: `moved to ${el} (focus only; may be a click on a switch, or just passing through)`,
    key: `pressed ${s.combo}`
  }
  const where = s.app ? ` in ${s.app.name}` : ''
  const opened = s.opened.length ? `; then ${s.opened.map(q).join(', ')} opened` : ''
  const shot = s.shot !== undefined ? ` [screenshot ${s.shot + 1}]` : ''
  return `${i + 1}. ${what[s.kind]}${where}${opened}${shot}`
}

/** "Control Shift S" for the ear (the say lint spells shortcuts out). */
export function spokenCombo(combo: string): string {
  const names: Record<string, string> = { ctrl: 'Control', win: 'Windows', esc: 'Escape' }
  return combo
    .split('+')
    .map((k) => names[k.toLowerCase()] ?? k)
    .join(' ')
}

/** The say line when the model gave none. */
export function fallbackSay(s: SkeletonStep): string {
  const name = s.name ?? s.automationId ?? 'it'
  switch (s.kind) {
    case 'invoked':
      return `Click ${name}.`
    case 'selected':
      return `Select ${name}.`
    case 'text':
      return `Type what you need in the ${name} box.`
    case 'focused':
      return `Go to ${name}.`
    case 'key':
      return `Press ${spokenCombo(s.combo ?? '')}.`
  }
}

function targetOf(s: SkeletonStep): LessonTarget | null {
  if (s.kind === 'key') return s.combo ? { shortcut: s.combo } : null
  const element: ElementMatch = {
    ...(s.name ? { name: s.name } : {}),
    ...(s.role ? { role: s.role } : {}),
    ...(!s.name && s.automationId ? { automationId: s.automationId } : {})
  }
  return Object.keys(element).length ? { element } : null
}

/** The check a recorded step waits for: the UIA event or shortcut seen, vision as the fallback. */
export function checkOf(s: SkeletonStep, say: string): CheckSpec {
  const vision: CheckSpec = { type: 'vision', prompt: derivedVisionPrompt(say) }
  if (s.kind === 'key')
    return s.combo
      ? { type: 'anyOf', checks: [{ type: 'keypress', combo: s.combo }, vision] }
      : vision
  const match = {
    ...(s.name ? { name: s.name } : {}),
    ...(s.role ? { role: s.role } : {}),
    ...(!s.name && s.automationId ? { automationId: s.automationId } : {})
  }
  const event = s.kind === 'text' ? 'value' : s.kind
  return { type: 'anyOf', checks: [{ type: 'uia-event', event, match }, vision] }
}

/** What the model may write for each step (flat, every field required). */
export interface DraftText {
  title: string
  steps: { from: number; say: string; why: string; hint: string }[]
}

export interface DraftContext {
  app: RecordedApp
  /** The title the user said ("watch me turn on dark mode"). */
  title?: string
  minutes?: number
}

/**
 * The C9 lesson for a skeleton. `text` (the model's lines) picks and orders steps by `from`
 * (1-based); without it, or for steps it left out entirely, every step gets a plain line.
 */
export function draftLesson(
  steps: SkeletonStep[],
  text: DraftText | null,
  ctx: DraftContext
): Lesson | null {
  if (!steps.length) return null
  const picked: { s: SkeletonStep; say: string; why: string; hint: string }[] = []
  let lastIndex = -1
  for (const t of text?.steps ?? []) {
    // In order, each step once.
    const i = Math.round(t.from) - 1
    if (!(i > lastIndex && i < steps.length)) continue
    lastIndex = i
    const say = spoken(t.say, 200)
    picked.push({
      s: steps[i],
      say: say.length >= 3 ? say : fallbackSay(steps[i]),
      why: t.why,
      hint: t.hint
    })
  }
  if (!picked.length)
    for (const s of steps) picked.push({ s, say: fallbackSay(s), why: '', hint: '' })

  const lessonSteps: StoredLesson['steps'] = picked.map((p, i) => {
    const why = spoken(p.why, 200)
    const hint = spoken(p.hint, 240)
    return {
      id: `s${i + 1}-${slug(p.say, 24)}`,
      say: p.say,
      target: targetOf(p.s),
      expect: { type: 'user-action', check: checkOf(p.s, p.say) },
      hints: hint.length >= 3 && hint.toLowerCase() !== p.say.toLowerCase() ? [hint] : [],
      ...(why.length >= 3 ? { why } : {})
    }
  })
  const title =
    [ctx.title, text?.title].map((t) => spoken(t ?? '', 80)).find((t) => t.length >= 3) ??
    `My steps in ${ctx.app.name}`
  const stored: StoredLesson = {
    id: `${ctx.app.id}-draft-${slug(title, 40)}`,
    app: ctx.app.id,
    title,
    summary: `Recorded by you: ${lessonSteps.length} steps in ${ctx.app.name}.`,
    level: 'beginner',
    minutes: Math.min(60, Math.max(1, Math.round(ctx.minutes ?? lessonSteps.length / 2))),
    prereqs: [],
    appVersion: 'any',
    tags: ['recorded'],
    steps: lessonSteps
  }
  try {
    return parseLesson(stored)
  } catch {
    return null
  }
}

/** The draft with the user's edits: kept steps in the given order with new say lines. */
export function editDraft(
  draft: Lesson,
  edit: { title: string; steps: { id: string; say: string }[] }
): Lesson | null {
  const byId = new Map(draft.steps.map((s) => [s.id, s]))
  const steps: LessonStep[] = []
  for (const e of edit.steps) {
    const s = byId.get(e.id)
    const say = spoken(e.say, 200)
    if (!s || say.length < 3) continue
    byId.delete(e.id)
    steps.push({ ...s, say, check: resay(s.check, s.say, say) })
  }
  if (!steps.length) return null
  const title = spoken(edit.title, 80)
  return { ...draft, title: title.length >= 3 ? title : draft.title, steps }
}

/** The check with its say-derived vision prompt following the new say line. */
function resay(c: CheckSpec, oldSay: string, say: string): CheckSpec {
  if (c.type === 'vision' && c.prompt === derivedVisionPrompt(oldSay))
    return { type: 'vision', prompt: derivedVisionPrompt(say) }
  if (c.type === 'anyOf' || c.type === 'allOf')
    return { type: c.type, checks: c.checks.map((x) => resay(x, oldSay, say)) }
  return c
}

const quoted = (m: { name?: string; automationId?: string }): string =>
  `“${m.name ?? m.automationId ?? 'it'}”`

/** What a step waits for, in words (Settings review). */
export function waitsFor(c: CheckSpec): string {
  switch (c.type) {
    case 'uia-event': {
      const what = quoted(c.match)
      if (c.event === 'invoked') return `a click on ${what}`
      if (c.event === 'selected') return `${what} being selected`
      if (c.event === 'value') return `text in ${what}`
      if (c.event === 'window-opened') return `${what} to open`
      return `focus on ${what}`
    }
    case 'keypress':
      return c.combo
    case 'anyOf':
    case 'allOf':
      return c.checks[0] ? waitsFor(c.checks[0]) : 'you to say “done”'
    case 'vision':
      return 'a look at the screen'
    default:
      return 'you to say “done”'
  }
}
