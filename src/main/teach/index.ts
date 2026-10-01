// Lesson engine wiring (plans 07 Phase 1): the real ports on top of the agent, the verifier,
// the announcer and the bus; the registry and progress store; the router hook for lesson
// voice commands. index.ts calls installTeach() once the agent and a11y are set up.
import { app, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import type { ElementNode, InputStep, Point, Rect } from '@shared/types'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log, type LogTag } from '../logger'
import { physRectToLogical, physToLogical, rectCenter } from '../actions/coords'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { announce, wantFocusEvents } from '../a11y'
import { decodeGray, diffRatio, type GrayImage } from '../ai/frames'
import { verifyExpectation } from '../ai/verify'
import { flattenElements } from '../query/uia-list'
import { matchStartLesson, parseLessonCommand, pickLesson } from './commands'
import { setLessonContextProvider } from './context'
import { paceFromTimings } from './hints'
import type { DoAction, ElementMatch, LessonTarget } from './lesson'
import type { Frame, Ports, ResolvedTarget, UiaEvent, WindowInfo } from './ports'
import { noopPorts } from './ports'
import { ProgressStore, resumeOffer, type ResumeOffer } from './progress'
import { SkillRegistry, type Skill } from './registry'
import { LessonRunner } from './runner'
import { lessonKeysAllowed, lessonUrlAllowed } from './safety'

/** Same reply shape as 06's local grammar: handled, nothing for the renderer to show. */
const HANDLED = { mode: 'answer', text: '', local: true, dictated: true } as const

const CAPTURE_TIMEOUT_MS = 4000
const UIA_TIMEOUT_MS = 2500
const INPUT_TIMEOUT_MS = 15_000
const FRAME_CACHE = 8
/** The lesson app has been out of focus this long → pause. */
const BLUR_PAUSE_MS = 60_000
const BLUR_POLL_MS = 5000
const RESUME_OFFER_DELAY_MS = 4000

let registry: SkillRegistry | null = null
let store: ProgressStore | null = null
let runner: LessonRunner | null = null
let offer: ResumeOffer | null = null

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

async function foreground(): Promise<commands.ActiveWindowResult | null> {
  const agent = getAgent()
  if (!agent) return null
  return commands.activeWindow(agent, { timeoutMs: 1500 }).catch(() => null)
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
async function findElements(q: ElementMatch): Promise<ElementNode[]> {
  const agent = getAgent()
  if (!agent) return []
  for (const interactiveOnly of [true, false]) {
    const snap = await commands
      .uiaSnapshot(
        agent,
        { scope: 'foreground', maxNodes: 600, interactiveOnly },
        { timeoutMs: UIA_TIMEOUT_MS }
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
  skill: Skill | null | undefined
): Promise<ResolvedTarget | null> {
  if ('element' in t) {
    const el = pickNth(await findElements(t.element), t.element.nth)
    return el ? fromPhys(el.rect, 'element', el.id) : null
  }
  const fg = await foreground()
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
    if (!agent || !win) return null
    const ocr = await commands
      .ocr(agent, { region: win }, { timeoutMs: CAPTURE_TIMEOUT_MS })
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
}

function setKeyObservation(on: boolean): void {
  const agent = getAgent()
  if (!agent?.hasCapability('key-combo')) return
  agent
    .request('subscribe', { events: ['key-combo'], enabled: on })
    .catch((e: Error) => log('skip', `key-combo subscribe failed (${e.message})`))
}

// ---- Do it for me ----

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason)
    })
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

// ---- Ports ----

function realPorts(): Ports {
  return noopPorts({
    screen: {
      capture: (o) => capture(!!o?.low).catch(() => null),
      diff,
      emitScene: (scene) => bus.emit({ type: 'lesson.scene', scene }),
      emitState: (state) => bus.emit({ type: 'lesson.state', state })
    },
    target: { resolveTarget: (t, ctx) => resolveTarget(t, ctx.skill).catch(() => null) },
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

export function teachRunner(): LessonRunner | null {
  return runner
}

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
    pace: paceFromTimings(loadConfig().a11y.timings),
    ...opts,
    stats: opts.stepIndex !== undefined && active?.lessonId === id ? active.steps : undefined
  })
  log(
    'step',
    `lesson ${id} started${opts.stepIndex !== undefined ? ` at step ${opts.stepIndex + 1}` : ''}`
  )
  return true
}

function resumeOffered(): boolean {
  const o = offer
  if (!o || !runner) return false
  offer = null
  if (o.lesson && !registry?.lesson(o.lessonId)) {
    // Generated lesson kept inline in the progress file.
    runner.start(o.lesson, {
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
 * only), "resume" / "no" for a resume offer, and "start lesson …" / "teach me …" for a pack
 * lesson. Anything else returns undefined and goes on to the assistant with lesson context.
 */
export function interceptLesson(utterance: string): unknown | undefined {
  if (!runner || !registry) return undefined
  const cmd = parseLessonCommand(utterance)
  if (runner.running()) {
    if (cmd && runner.command(cmd)) {
      log('plan', `lesson command: ${cmd}`)
      return HANDLED
    }
    return undefined
  }
  if (offer && cmd) {
    if (cmd === 'resume' || cmd === 'yes' || cmd === 'next')
      return resumeOffered() ? HANDLED : undefined
    if (cmd === 'no') {
      offer = null
      store?.clearActive()
      return HANDLED
    }
  }
  const query = matchStartLesson(utterance)
  if (query) {
    const lessons = registry
      .all()
      .flatMap((s) =>
        s.lessons.map((l) => ({ id: l.id, title: l.title, appId: s.id, appName: s.name }))
      )
    const hit = pickLesson(query, lessons)
    if (hit && startLesson(hit.id)) return HANDLED
  }
  return undefined
}

/** Pauses the lesson when its app has been out of focus for a minute (not for Windows itself). */
function watchFocus(): void {
  let awaySince: number | null = null
  setInterval(() => {
    const r = runner
    if (!r?.running() || r.state.phase !== 'step.waiting' || r.state.skillId === 'windows') {
      awaySince = null
      return
    }
    void foreground().then((w) => {
      if (!w || !registry) return
      const here = registry.matchApp({ process: w.process || w.exe, title: w.title })?.id
      const lumen = /\blumen\b/i.test(w.title)
      if (here === r.state.skillId || lumen) awaySince = null
      else if (awaySince === null) awaySince = Date.now()
      else if (Date.now() - awaySince >= BLUR_PAUSE_MS) {
        awaySince = null
        r.appBlurred()
      }
    })
  }, BLUR_POLL_MS).unref?.()
}

export function installTeach(): void {
  if (runner) return
  const base = join(homedir(), '.ai-overlay')
  registry = new SkillRegistry({
    builtin: join(app.getAppPath(), 'skills'),
    user: join(base, 'skills')
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
