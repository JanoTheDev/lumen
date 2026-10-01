// Lesson engine wiring (plans 07 Phase 1): the real ports on top of the agent, the verifier,
// the announcer and the bus; the registry and progress store; the router hook for lesson
// voice commands. index.ts calls installTeach() once the agent and a11y are set up.
import { app, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import type { LessonListItem, LessonProgressView } from '@shared/channels'
import type { LessonCommand } from '@shared/events'
import type { ElementNode, InputStep, Point, Rect } from '@shared/types'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log, type LogTag } from '../logger'
import { physRectToLogical, physToLogical, rectCenter } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { announce } from '../a11y'
import { wantFocusEvents } from '../a11y/focus-events'
import { LOCAL_HANDLED as HANDLED } from '../a11y/dispatch'
import { decodeGray, diffRatio, type GrayImage } from '../ai/frames'
import { verifyExpectation } from '../ai/verify'
import { WHY_PROMPT, whyTurn } from '../ai/prompts/lesson'
import { getProvider } from '../ai/providers'
import { skillContext } from '../ai/skills'
import { matchPlayGuide } from '../guides/voice-nav'
import { setTeachHandler } from '../query/pipeline'
import { flattenElements } from '../query/uia-list'
import {
  lessonNumber,
  matchAppOnly,
  matchSaveLesson,
  matchStartLesson,
  parseLessonCommand,
  pickLesson,
  type LessonCandidate
} from './commands'
import { setLessonContextProvider } from './context'
import { pacingFor } from './hints'
import type { DoAction, ElementMatch, Lesson, LessonTarget } from './lesson'
import { migrateGuides } from './migrate-guides'
import type { Frame, Ports, ResolvedTarget, UiaEvent, WindowInfo } from './ports'
import { noopPorts } from './ports'
import { ProgressStore, resumeOffer, type ResumeOffer } from './progress'
import { SkillRegistry, hasMatchRules, type Skill } from './registry'
import { LessonRunner } from './runner'
import { lessonKeysAllowed, lessonUrlAllowed } from './safety'
import { bridgePort, installBridgeOffer } from './bridges'
import { lessonList, progressView } from './picker'
import { PRACTICE_LESSON, PRACTICE_LESSON_ID } from './practice-lesson'
import { makeShowMeHow } from './show-me'
import { deleteUserLesson, freeLessonId, userLessonsDir, writeUserLesson } from './user-lessons'

const CAPTURE_TIMEOUT_MS = 4000
const UIA_TIMEOUT_MS = 2500
const INPUT_TIMEOUT_MS = 15_000
const FRAME_CACHE = 8
/** The lesson app has been out of focus this long → pause. */
const BLUR_PAUSE_MS = 60_000
const BLUR_POLL_MS = 5000
const RESUME_OFFER_DELAY_MS = 4000
/** "start lesson 2" refers to the list "teach me <app>" read out this recently. */
const LIST_TTL_MS = 5 * 60_000
const LIST_MAX = 9

let registry: SkillRegistry | null = null
let store: ProgressStore | null = null
let runner: LessonRunner | null = null
let offer: ResumeOffer | null = null
/** The last "show me how" lesson, for "save this lesson". */
let lastGenerated: { lesson: Lesson; skill: Skill | null } | null = null
let skillsRoot = ''
/** The numbered lessons "teach me <app>" read out last. */
let listed: { ids: string[]; at: number } | null = null

const frames = new Map<string, string>()

function remember(id: string, data: string): void {
  frames.set(id, data)
  while (frames.size > FRAME_CACHE) frames.delete(frames.keys().next().value!)
}

// ---- Screen ----

async function capture(low = false): Promise<Frame | null> {
  const agent = getAgent()
  if (!agent) return null
  const r = await commands.capture(
    agent,
    { monitor: 'foreground', maxWidth: low ? 320 : 1280, quality: low ? 50 : 75 },
    { timeoutMs: CAPTURE_TIMEOUT_MS }
  )
  const f = r.frames[0]
  if (!f) return null
  if (!low) remember(f.id, f.data)
  return { id: f.id, sig: decodeGray(f.data) }
}

function diff(a: Frame, b: Frame): number | null {
  const ga = a.sig as GrayImage | null | undefined
  const gb = b.sig as GrayImage | null | undefined
  return ga && gb ? diffRatio(ga, gb) : null
}

// ---- Foreground window, UIA, OCR ----

/** The last foreground window any lesson code asked for (checks poll it at 2 Hz). */
let lastForeground: { at: number; w: commands.ActiveWindowInfo } | null = null

async function foreground(signal?: AbortSignal): Promise<commands.ActiveWindowInfo | null> {
  const agent = getAgent()
  if (!agent || signal?.aborted) return null
  const w = await commands.activeWindow(agent, { timeoutMs: 1500, signal }).catch(() => null)
  if (w) lastForeground = { at: Date.now(), w }
  return w
}

/** The foreground window, reusing one seen within `maxAgeMs` (no second poller). */
function recentForeground(maxAgeMs: number): Promise<commands.ActiveWindowInfo | null> {
  const last = lastForeground
  return last && Date.now() - last.at < maxAgeMs ? Promise.resolve(last.w) : foreground()
}

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

function elementHits(nodes: ElementNode[], q: ElementMatch): ElementNode[] {
  const byRole = nodes.filter(
    (n) =>
      (!q.role || norm(n.role) === norm(q.role)) &&
      (!q.automationId || n.automationId === q.automationId)
  )
  if (!q.name) return byRole
  const exact = byRole.filter((n) => norm(n.name) === norm(q.name))
  return exact.length ? exact : byRole.filter((n) => norm(n.name).includes(norm(q.name)))
}

/** Elements of the foreground window matching the query, interactive ones first. */
async function findElements(q: ElementMatch, signal?: AbortSignal): Promise<ElementNode[]> {
  const agent = getAgent()
  if (!agent) return []
  for (const interactiveOnly of [true, false]) {
    if (signal?.aborted) return []
    const snap = await commands
      .uiaSnapshot(
        agent,
        { scope: 'foreground', maxNodes: 600, interactiveOnly },
        { timeoutMs: UIA_TIMEOUT_MS, signal }
      )
      .catch(() => null)
    if (!snap) return []
    const hits = elementHits(
      flattenElements(snap.root).map((f) => f.node),
      q
    )
    if (hits.length) return hits
  }
  return []
}

const pickNth = <T>(list: T[], nth = 0): T | undefined => list[Math.min(nth, list.length - 1)]

function regionRect(skill: Skill | null | undefined, name: string, win: Rect): Rect | null {
  const r = skill?.regions[name]
  if (!r) return null
  return { x: win.x + r.x * win.w, y: win.y + r.y * win.h, w: r.w * win.w, h: r.h * win.h }
}

function fromPhys(
  physRect: Rect,
  source: ResolvedTarget['source'],
  elementId?: string
): ResolvedTarget {
  const rect = physRectToLogical(physRect)
  return { rect, point: rectCenter(rect), source, ...(elementId ? { elementId } : {}) }
}

async function resolveTarget(
  t: LessonTarget,
  skill: Skill | null | undefined,
  signal?: AbortSignal
): Promise<ResolvedTarget | null> {
  if ('element' in t) {
    const el = pickNth(await findElements(t.element, signal), t.element.nth)
    return el ? fromPhys(el.rect, 'element', el.id) : null
  }
  const fg = await foreground(signal)
  const win = fg?.rect
  if ('shortcut' in t) {
    if (!win) return null
    return { point: physToLogical(rectCenter(win)), source: 'shortcut' }
  }
  if ('region' in t) {
    const r = win ? regionRect(skill, t.region, win) : null
    return r ? { ...fromPhys(r, 'region'), where: skill?.regions[t.region]?.desc } : null
  }
  if ('text' in t) {
    const agent = getAgent()
    if (!agent || !win || signal?.aborted) return null
    const ocr = await commands
      .ocr(agent, { region: win }, { timeoutMs: CAPTURE_TIMEOUT_MS, signal })
      .catch(() => null)
    const lines = (ocr?.lines ?? []).filter((l) => norm(l.text).includes(norm(t.text)))
    const hit = pickNth(lines, t.nth)
    return hit ? fromPhys(hit.rect, 'text') : null
  }
  // mark / point: generated lessons only (T18 resolves them with 05's resolveTarget).
  return null
}

// ---- UIA events and key combos (agent events, fanned out) ----

const uiaSubs = new Set<{ kinds: Set<string>; cb: (e: UiaEvent) => void }>()
const keySubs = new Set<(combo: string) => void>()

function elementOf(data: unknown): UiaEvent['element'] {
  const el = ((data as { element?: Record<string, unknown> } | null)?.element ?? {}) as Record<
    string,
    unknown
  >
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    name: str(el.name),
    role: str(el.role),
    automationId: str(el.automationId),
    value: str(el.value)
  }
}

function emitUia(e: UiaEvent): void {
  for (const s of uiaSubs) if (s.kinds.has(e.kind)) s.cb(e)
}

function wireAgentEvents(): void {
  const agent = getAgent()
  if (!agent) return
  agent.onEvent('focus-changed', (data) => {
    if (uiaSubs.size) emitUia({ kind: 'focused', element: elementOf(data) })
  })
  // Requested from 02: invoke / value / selection / window-opened events.
  agent.onEvent('uia-event', (data) => {
    const kind = (data as { kind?: unknown } | null)?.kind
    if (typeof kind === 'string' && uiaSubs.size)
      emitUia({ kind: kind as UiaEvent['kind'], element: elementOf(data) })
  })
  // Requested from 02: observe-only key combos while a lesson step is active.
  agent.onEvent('key-combo', (data) => {
    const combo = (data as { combo?: unknown } | null)?.combo
    if (typeof combo === 'string') for (const cb of keySubs) cb(combo)
  })
  // A fresh agent has no subscriptions; ask again while a step watches for keys.
  agent.onEvent('agent-ready', () => {
    if (keySubs.size) setKeyObservation(true)
  })
}

function setKeyObservation(on: boolean): void {
  const agent = getAgent()
  if (!agent?.hasCapability('key-combo')) return
  agent
    .request('subscribe', { events: ['key-combo'], enabled: on })
    .catch((e: Error) => log('skip', `key-combo subscribe failed (${e.message})`))
}

// ---- Do it for me ----

export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal.reason)
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

async function regionPoint(
  skill: Skill | null | undefined,
  region: string | undefined
): Promise<Point | null> {
  if (!region) return null
  const win = (await foreground())?.rect
  const r = win ? regionRect(skill, region, win) : null
  return r ? rectCenter(r) : null
}

async function runAction(
  a: DoAction,
  skill: Skill | null | undefined,
  signal: AbortSignal
): Promise<boolean> {
  const agent = getAgent()
  if (!agent) return false
  const input = async (steps: InputStep[]): Promise<boolean> =>
    !!(await commands.input(agent, steps, { timeoutMs: INPUT_TIMEOUT_MS })).done
  switch (a.t) {
    case 'keys':
      if (!lessonKeysAllowed(a.combo)) {
        log('skip', `lesson keys denied: ${a.combo}`)
        return false
      }
      return input([{ t: 'keys', combo: a.combo }])
    case 'type':
      return input([{ t: 'type', text: a.text }])
    case 'wait':
      await sleep(a.ms, signal)
      return true
    case 'open_url':
      if (!lessonUrlAllowed(a.url)) {
        log('skip', `lesson url denied: ${a.url}`)
        return false
      }
      await shell.openExternal(a.url)
      return true
    case 'invoke': {
      const el = pickNth(await findElements(a.element), a.element.nth)
      if (!el) return false
      const action = el.patterns.includes('invoke')
        ? 'invoke'
        : el.patterns.includes('select')
          ? 'select'
          : el.patterns.includes('toggle')
            ? 'toggle'
            : el.patterns.includes('expand')
              ? 'expand'
              : null
      if (action) {
        const r = await commands.uiaAct(
          agent,
          { elementId: el.id, action },
          { timeoutMs: UIA_TIMEOUT_MS }
        )
        if (r.done) return true
      }
      const c = rectCenter(el.rect)
      return input([{ t: 'click', button: 'left', x: c.x, y: c.y }])
    }
    case 'move':
    case 'click':
    case 'scroll': {
      const p = await regionPoint(skill, a.region)
      if (a.region && !p) return false
      if (a.t === 'move') return input([{ t: 'move', x: p!.x, y: p!.y }])
      if (a.t === 'scroll') return input([{ t: 'scroll', dx: a.dx, dy: a.dy, ...(p ?? {}) }])
      const button = a.button === 'right' ? 'right' : 'left'
      return input([{ t: 'click', button, count: a.count, ...(p ?? {}) }])
    }
  }
}

// ---- Why? ----

const WHY_TIMEOUT_MS = 8000
const WHY_NOTES_TOKENS = 600

async function explainWhy(
  lesson: Lesson,
  step: Lesson['steps'][number],
  skill: Skill | null,
  signal?: AbortSignal
): Promise<string | null> {
  const { llm, model, effort } = getProvider('fast')
  const i = lesson.steps.indexOf(step)
  const timeout = AbortSignal.timeout(WHY_TIMEOUT_MS)
  const res = await llm.complete(
    {
      model,
      system: [{ text: WHY_PROMPT, cacheable: true }],
      messages: [
        {
          role: 'user',
          content: whyTurn({
            app: skill?.name ?? lesson.app,
            lessonTitle: lesson.title,
            step: step.say,
            previous: lesson.steps[i - 1]?.say,
            next: lesson.steps[i + 1]?.say,
            appNotes:
              skill && hasMatchRules(skill)
                ? skillContext(skill, step.say, WHY_NOTES_TOKENS)
                : undefined
          })
        }
      ],
      maxTokens: 120,
      effort
    },
    signal ? AbortSignal.any([signal, timeout]) : timeout
  )
  log('plan', `lesson why for ${lesson.id}/${step.id} (${res.model})`)
  return res.text.trim() || null
}

// ---- Ports ----

function realPorts(): Ports {
  return noopPorts({
    screen: {
      capture: (o) => capture(!!o?.low).catch(() => null),
      diff,
      emitScene: (scene) => bus.emit({ type: 'lesson.scene', scene }),
      emitState: (state) => bus.emit({ type: 'lesson.state', state })
    },
    target: {
      resolveTarget: (t, ctx) => resolveTarget(t, ctx.skill, ctx.signal).catch(() => null)
    },
    verify: {
      vision: async (prompt, beforeId, afterId, signal) => {
        const before = frames.get(beforeId)
        const after = frames.get(afterId)
        if (!before || !after) return 'unknown'
        const v = await verifyExpectation(
          { check: 'vision', prompt },
          { at: 0, title: '', image: before },
          { at: Date.now(), title: '', image: after },
          signal
        )
        log('verify', `lesson vision: ${v.ok ? 'yes' : 'no'} (${v.reason})`)
        return v.ok ? 'pass' : v.confidence > 0 ? 'fail' : 'unknown'
      }
    },
    uia: {
      find: (q) => findElements(q),
      subscribe: (kinds, cb) => {
        const sub = { kinds: new Set<string>(kinds), cb }
        uiaSubs.add(sub)
        wantFocusEvents('lesson', true)
        return () => {
          uiaSubs.delete(sub)
          if (!uiaSubs.size) wantFocusEvents('lesson', false)
        }
      }
    },
    window: {
      activeWindow: async (): Promise<WindowInfo | null> => {
        const w = await foreground()
        return w ? { title: w.title, process: w.process || w.exe } : null
      }
    },
    keys: {
      available: () => !!getAgent()?.hasCapability('key-combo'),
      onCombo: (cb) => {
        keySubs.add(cb)
        if (keySubs.size === 1) setKeyObservation(true)
        return () => {
          keySubs.delete(cb)
          if (!keySubs.size) setKeyObservation(false)
        }
      }
    },
    exec: {
      run: async (actions, { skill, signal }) => {
        for (const a of actions) {
          if (signal.aborted) return false
          if (!(await runAction(a, skill, signal).catch(() => false))) return false
        }
        return true
      }
    },
    // The announcer routes to the screen reader, TTS or captions only, per the user's settings.
    speak: { say: (text) => announce(text, { kind: 'step', priority: 'assertive' }) },
    announce: { announce: () => {} },
    bridge: bridgePort,
    explain: {
      why: (lesson, step, skill, signal) =>
        explainWhy(lesson, step, skill, signal).catch((e: Error) => {
          log('fail', `lesson why failed (${e.message})`)
          return null
        })
    },
    events: {
      stepStarted: (lessonId, step) => bus.emit({ type: 'lesson.step-started', lessonId, step }),
      stepCompleted: (lessonId, step) =>
        bus.emit({ type: 'lesson.step-completed', lessonId, step }),
      done: (lessonId, completed) => bus.emit({ type: 'lesson.done', lessonId, completed })
    },
    log: (tag, msg) => log(tag as LogTag, msg)
  })
}

// ---- Public API ----

export function skillRegistry(): SkillRegistry | null {
  return registry
}

/** Starts a pack lesson by id; false when there is no such lesson. */
export function startLesson(
  id: string,
  opts: { stepIndex?: number; autoStart?: boolean } = {}
): boolean {
  const found = registry?.lesson(id)
  if (!found || !runner) return false
  offer = null
  const active = store?.get().active
  runner.start(found.lesson, {
    skill: found.skill,
    source: found.skill.source === 'user' ? 'user' : 'pack',
    ...pacingFor(loadConfig().a11y),
    ...opts,
    stats: opts.stepIndex !== undefined && active?.lessonId === id ? active.steps : undefined
  })
  log(
    'step',
    `lesson ${id} started${opts.stepIndex !== undefined ? ` at step ${opts.stepIndex + 1}` : ''}`
  )
  return true
}

/** Starts a lesson made by "show me how" right at its first step. */
function startGenerated(lesson: Lesson, skill: Skill | null): void {
  if (!runner) return
  offer = null
  lastGenerated = { lesson, skill }
  runner.start(lesson, {
    skill,
    source: 'generated',
    autoStart: true,
    ...pacingFor(loadConfig().a11y)
  })
}

/** Writes the last generated lesson to the user's lessons; null when there is none. */
export function saveGeneratedLesson(name?: string): Lesson | null {
  const last = lastGenerated
  if (!last || !registry || !skillsRoot) return null
  const dir = userLessonsDir(skillsRoot)
  const title = (name?.trim() || last.lesson.title).slice(0, 80)
  const lesson: Lesson = {
    ...last.lesson,
    id: freeLessonId(dir, last.lesson.app, title),
    title: title.length >= 3 ? title : last.lesson.title,
    tags: ['saved']
  }
  try {
    writeUserLesson(dir, lesson)
  } catch (e) {
    log('fail', `saving lesson failed: ${(e as Error).message}`)
    return null
  }
  registry.load()
  lastGenerated = null
  log('done', `saved lesson "${lesson.title}" as ${lesson.id}`)
  return lesson
}

/**
 * Starts a lesson from the picker: the running one stays (a paused one resumes), the one left
 * part-way resumes on its step, the onboarding mini lesson starts at once, anything else from
 * its intro.
 */
export function startOrResume(id: string): boolean {
  if (!runner) return false
  if (runner.running() && runner.state.lesson?.id === id) {
    if (runner.state.phase === 'paused') runner.command('resume')
    return true
  }
  if (id === PRACTICE_LESSON_ID) {
    offer = null
    runner.start(PRACTICE_LESSON, {
      source: 'pack',
      autoStart: true,
      ...pacingFor(loadConfig().a11y)
    })
    return true
  }
  const o = store
    ? resumeOffer(store.get(), Date.now(), (lid) => {
        const f = registry?.lesson(lid)
        return f ? { lesson: f.lesson, appName: f.skill.name } : null
      })
    : null
  if (o?.lessonId === id) {
    offer = o
    return resumeOffered()
  }
  return startLesson(id)
}

/** A command from a button or switch; resume/yes also take a resume offer. */
export function lessonCommand(cmd: LessonCommand): boolean {
  if (!runner) return false
  if (runner.running()) return runner.command(cmd)
  return cmd === 'resume' || cmd === 'yes' ? resumeOffered() : false
}

export function listLessons(appId?: string): LessonListItem[] {
  if (!registry || !store) return []
  const mine = new Set(registry.userLessons().map((x) => x.lesson.id))
  return lessonList(registry.all(), store.get(), mine, appId)
}

export function lessonProgress(): LessonProgressView {
  if (!registry || !store) return { active: null, recent: [] }
  return progressView(store.get(), runner?.state ?? null, Date.now(), (id) => registry!.lesson(id))
}

/** Deletes one of the user's own lessons (never a pack lesson). */
export function deleteLesson(id: string): boolean {
  if (!registry || !skillsRoot) return false
  if (!registry.userLessons().some((x) => x.lesson.id === id)) return false
  const ok = deleteUserLesson(userLessonsDir(skillsRoot), id)
  if (ok) registry.load()
  return ok
}

/** The onboarding board's click, as the invoke event its mini lesson waits for. */
export function practiceClick(label: string): void {
  if (runner?.running() && runner.state.lesson?.id === PRACTICE_LESSON_ID)
    emitUia({ kind: 'invoked', element: { name: label, role: 'button' } })
}

/** "teach me blender": the app's beginner lessons, numbered for "start lesson 2". */
function listAppLessons(skill: Skill): unknown {
  const beginner = skill.lessons.filter((l) => l.level === 'beginner')
  const list = (beginner.length ? beginner : skill.lessons).slice(0, LIST_MAX)
  if (!list.length) return { mode: 'answer', text: `There are no ${skill.name} lessons yet.` }
  listed = { ids: list.map((l) => l.id), at: Date.now() }
  const text = `${skill.name} lessons: ${list.map((l, i) => `${i + 1}, ${l.title}`).join('. ')}. Say "start lesson" and a number.`
  announce(text, { kind: 'answer' })
  return { mode: 'answer', text }
}

function candidates(): LessonCandidate[] {
  return (registry?.all() ?? []).flatMap((s) =>
    s.lessons.map((l) => ({ id: l.id, title: l.title, appId: s.id, appName: s.name }))
  )
}

function resumeOffered(): boolean {
  const o = offer
  if (!o || !runner) return false
  offer = null
  if (o.lesson && !registry?.lesson(o.lessonId)) {
    // Generated lesson kept inline in the progress file.
    runner.start(o.lesson, {
      ...pacingFor(loadConfig().a11y),
      source: 'generated',
      stepIndex: o.stepIndex,
      stats: store?.get().active?.steps
    })
    return true
  }
  return startLesson(o.lessonId, { stepIndex: o.stepIndex })
}

/**
 * Router hook, before 06's grammar: lesson commands while a lesson runs (whole utterance
 * only), "resume" / "no" for a resume offer, and "start lesson …" / "teach me …" / "play
 * guide …" for a pack or user lesson (also while another lesson runs). Anything else returns
 * undefined and goes on to the assistant with lesson context.
 */
export function interceptLesson(utterance: string): unknown | undefined {
  if (!runner || !registry) return undefined
  const save = lastGenerated ? matchSaveLesson(utterance) : null
  if (save) {
    const saved = saveGeneratedLesson(save.name)
    return saved
      ? {
          mode: 'answer',
          text: `Saved "${saved.title}". Say "start lesson ${saved.title}" to play it again.`
        }
      : { mode: 'answer', text: 'I could not save that lesson.' }
  }
  const cmd = parseLessonCommand(utterance)
  const running = runner.running()
  if (running && cmd && runner.command(cmd)) {
    log('plan', `lesson command: ${cmd}`)
    return HANDLED
  }
  if (!running && offer && cmd) {
    if (cmd === 'resume' || cmd === 'yes' || cmd === 'next')
      return resumeOffered() ? HANDLED : undefined
    if (cmd === 'no') {
      offer = null
      store?.clearActive()
      return HANDLED
    }
  }
  // "play guide <name>": saved guides are user lessons now (T19).
  const guide = matchPlayGuide(utterance)
  if (guide) {
    const mine = registry.userLessons().map(({ lesson, skill }) => ({
      id: lesson.id,
      title: lesson.title,
      appId: skill.id,
      appName: skill.name
    }))
    const hit = pickLesson(guide, mine)
    if (hit && startLesson(hit.id)) return HANDLED
  }
  const query = matchStartLesson(utterance)
  if (query) {
    const n = lessonNumber(query)
    if (n !== null && listed && Date.now() - listed.at < LIST_TTL_MS) {
      const id = listed.ids[n - 1]
      if (id && startOrResume(id)) return HANDLED
      return { mode: 'answer', text: `There is no lesson ${n} in that list.` }
    }
    const appId = matchAppOnly(query, registry.all())
    const app = appId ? registry.get(appId) : null
    if (app) return listAppLessons(app)
    const hit = pickLesson(query, candidates())
    if (hit && startLesson(hit.id)) return HANDLED
  }
  return undefined
}

/** Pauses the lesson when its app has been out of focus for a minute (not for Windows itself). */
function watchFocus(): void {
  let away: { step: string; since: number } | null = null
  setInterval(() => {
    const r = runner
    const step = r ? watchedStep(r) : null
    if (!r || !step) {
      away = null
      return
    }
    void recentForeground(BLUR_POLL_MS).then((w) => {
      // The lesson or step may have moved on while the agent answered.
      if (!w || !registry || watchedStep(r) !== step) return
      if (away?.step !== step) away = null
      const here = registry.matchApp({ process: w.process || w.exe, title: w.title })?.id
      const lumen = /\blumen\b/i.test(w.title)
      if (here === r.state.skillId || lumen) away = null
      else if (!away) away = { step, since: Date.now() }
      else if (Date.now() - away.since >= BLUR_PAUSE_MS) {
        away = null
        r.appBlurred()
      }
    })
  }, BLUR_POLL_MS).unref?.()
}

/** The waiting step whose app focus is watched ("lesson#index"), else null. */
function watchedStep(r: LessonRunner): string | null {
  const skill = registry?.get(r.state.skillId ?? '')
  // Windows lessons span many apps; lessons-only skills cannot tell their app.
  const watched = !!skill && skill.id !== 'windows' && hasMatchRules(skill)
  if (!r.running() || r.state.phase !== 'step.waiting' || !watched) return null
  return `${r.state.lesson?.id}#${r.state.index}`
}

export function installTeach(): void {
  if (runner) return
  const base = join(homedir(), '.ai-overlay')
  skillsRoot = join(base, 'skills')
  // Saved guides become user lessons once; the originals go to guides.bak/ (T19).
  const moved = migrateGuides({
    guidesDir: join(base, 'guides'),
    lessonsDir: userLessonsDir(skillsRoot),
    backupDir: join(base, 'guides.bak')
  })
  for (const m of moved.migrated) log('done', `guide "${m.guide}" is now lesson ${m.lessonId}`)
  for (const f of moved.failed) log('fail', `guide not migrated: ${f.file} (${f.reason})`)
  registry = new SkillRegistry({
    builtin: join(app.getAppPath(), 'skills'),
    user: skillsRoot
  }).load()
  for (const p of registry.problems()) log('fail', `skill pack: ${p.file}: ${p.message}`)
  log(
    'plan',
    `teach: ${registry.all().length} packs, ${registry.all().reduce((n, s) => n + s.lessons.length, 0)} lessons`
  )

  store = new ProgressStore(join(base, 'teach', 'progress.json'))
  runner = new LessonRunner(realPorts(), { progress: store })
  wireAgentEvents()
  setLessonContextProvider(() => runner?.context() ?? null)
  setTeachHandler(makeShowMeHow({ registry: () => registry, start: startGenerated }))

  bus.on('lesson.command', (e) => {
    if (runner?.running()) runner.command(e.command)
    else if (e.command === 'resume' || e.command === 'yes') resumeOffered()
  })
  // Hint timers wait while the user is talking.
  bus.on('voice.started', () => runner?.hold('voice', true))
  bus.on('voice.stopped', () => runner?.hold('voice', false))
  bus.on('voice.cancelled', () => runner?.hold('voice', false))
  app.on('before-quit', () => store?.flush())
  watchFocus()
  installBridgeOffer((id) => registry?.lesson(id)?.skill.id ?? null)

  // Passive resume offer once the bar can show it; nothing starts by itself.
  offer = resumeOffer(store.get(), Date.now(), (id) => {
    const f = registry?.lesson(id)
    return f ? { lesson: f.lesson, appName: f.skill.name } : null
  })
  if (offer) {
    const o = offer
    setTimeout(() => {
      if (offer === o) bus.emit({ type: 'lesson.resume-offer', lessonId: o.lessonId, text: o.text })
    }, RESUME_OFFER_DELAY_MS)
  }
}
