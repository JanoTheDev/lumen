// The helpers wired to the app (11 Phase C): shortcut coach, fatigue proposals, error rescue,
// "what changed?", reading level and the learning journal, plus focus mode and undo. Each is
// off until switched on in Settings (Smart helpers) and works on this PC only; the only model
// call is an error explanation the user asked for. interceptHelpers() is the voice entry: it
// runs before the lesson / 06 grammar chain and claims only its own whole utterances.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CoachStatus } from '@shared/channels'
import type { ElementNode } from '@shared/types'
import { bus } from '../bus'
import { loadConfig, saveConfig, type AppConfig } from '../config'
import { log } from '../logger'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { keyComboEvents, uiaEvents } from '../agent/subscriptions'
import { executeActions } from '../actions/executor'
import { announce, setBeforeLocalChange } from '../a11y'
import { getProvider } from '../ai/providers'
import { decodeGray } from '../ai/frames'
import { onConfigPatched, patchConfig } from '../ipc/settings'
import { flattenElements } from '../query/uia-list'
import { skillRegistry } from '../teach'
import { requestConfirm } from '../windows/assistant'
import { focusOff, focusOn, installFocus } from '../focus'
import { installUndo, recentlyActed, undoLast } from '../undo'
import { JournalStore, summarize } from '../journal/journal'
import { parseHelperCommand, type HelperCommand } from './grammar'
import {
  dialogButtons,
  dialogText,
  OFFER_TEXT,
  RescueOffers,
  RESCUE_SYSTEM,
  rescueTurn,
  textLooksLikeError,
  titleLooksLikeError
} from './errors'
import {
  FatigueTracker,
  MisfireWatch,
  utteranceSignals,
  type FatigueState,
  type Proposal
} from './fatigue'
import {
  levelName,
  readingLevelFor,
  readingLevelLine,
  readingLevelLineFor,
  readingLevelPatch,
  stepLevel
} from './reading-level'
import { parseShortcutTable, ShortcutCoach, type CoachState } from './shortcuts'
import { describeChange, elementsOf, type ScreenState } from './what-changed'

const BASE = join(homedir(), '.ai-overlay')
const STATE_FILE = join(BASE, 'coach.json')
const AGENT_TIMEOUT_MS = 2500
const RESCUE_TIMEOUT_MS = 12_000
const SAVE_DELAY_MS = 2000
/** A small dialog gets its text read to check for an error (bigger windows are documents). */
const DIALOG_MAX = { w: 1100, h: 800 }

interface Persisted {
  shortcuts?: CoachState
  fatigue?: FatigueState
}

let installed = false
function coachOpts(): { after: number; mode: 'keys' | 'voice' } {
  const h = helpers()
  return { after: h.coachAfter, mode: h.coachMode }
}

// Empty until installHelpers() loads what was saved.
let coach = new ShortcutCoach({ entries: {} }, coachOpts)
let fatigue = new FatigueTracker({ answers: {} })
const misfire = new MisfireWatch()
const offers = new RescueOffers()
const journal = new JournalStore(join(BASE, 'journal'))
let baseline: ScreenState | null = null
let lastUtterance: { text: string; at: number } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let asking = false
/** The dialog an offer was made for (title, text, buttons). */
let rescueDialog: { title: string; text: string; buttons: string[]; app?: string } | null = null
const packTables = new Map<string, Record<string, string> | null>()

const helpers = (): AppConfig['helpers'] => loadConfig().helpers

// ---- State on disk (~/.ai-overlay/coach.json) ----

function loadState(): Persisted {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Persisted
  } catch {
    return {}
  }
}

function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true })
      const data: Persisted = { shortcuts: coach.snapshot(), fatigue: fatigue.snapshot() }
      writeFileSync(STATE_FILE, JSON.stringify(data), 'utf8')
    } catch (e) {
      log('fail', `coach state save failed: ${(e as Error).message}`)
    }
  }, SAVE_DELAY_MS)
}

// ---- Foreground and app ----

async function foreground(): Promise<commands.ActiveWindowInfo | null> {
  const agent = getAgent()
  if (!agent) return null
  return commands.activeWindow(agent, { timeoutMs: AGENT_TIMEOUT_MS }).catch(() => null)
}

/** App id (pack id, else the process name) and display name. */
function appOf(
  w: commands.ActiveWindowInfo | null
): { id: string; name: string; packDir?: string } | null {
  if (!w) return null
  const skill = skillRegistry()?.matchApp(w)
  if (skill) return { id: skill.id, name: skill.name, packDir: skill.dir }
  const proc = (w.process || w.exe || '').replace(/\.exe$/i, '').toLowerCase()
  return proc ? { id: proc, name: proc } : null
}

function packTable(app: { id: string; packDir?: string }): Record<string, string> | null {
  if (packTables.has(app.id)) return packTables.get(app.id) ?? null
  let table: Record<string, string> | null = null
  if (app.packDir) {
    try {
      table = parseShortcutTable(readFileSync(join(app.packDir, 'shortcuts.md'), 'utf8'))
    } catch {
      table = null
    }
  }
  packTables.set(app.id, table)
  return table
}

async function foregroundNodes(maxNodes = 300): Promise<ElementNode[]> {
  const agent = getAgent()
  if (!agent) return []
  const snap = await commands
    .uiaSnapshot(
      agent,
      { scope: 'foreground', maxNodes, interactiveOnly: false },
      { timeoutMs: AGENT_TIMEOUT_MS }
    )
    .catch(() => null)
  return snap ? flattenElements(snap.root).map((f) => f.node) : []
}

// ---- Subscriptions (only while a helper needs them) ----

function syncSubscriptions(cfg = helpers()): void {
  uiaEvents.want('coach', cfg.shortcutCoach || cfg.errorRescue)
  keyComboEvents.want('coach', cfg.shortcutCoach || cfg.fatigue)
}

// ---- Shortcut coach ----

async function onInvoked(el: { name?: string; role?: string }): Promise<void> {
  const cfg = helpers()
  if (!cfg.shortcutCoach || !el.name || (el.role !== 'menuitem' && el.role !== 'button')) return
  const app = appOf(await foreground())
  if (!app) return
  const tip = coach.onInvoke(app.id, el.name, packTable(app), Date.now())
  saveSoon()
  if (tip) announce(tip, { kind: 'status' })
}

async function onCombo(combo: string): Promise<void> {
  const cfg = helpers()
  if (cfg.fatigue && misfire.onCombo(combo, Date.now())) noteSignal('dwell-misfire')
  if (!cfg.shortcutCoach) return
  const app = appOf(await foreground())
  if (!app) return
  const learned = coach.onCombo(app.id, combo)
  if (!learned) return
  saveSoon()
  log('step', `shortcut coach: ${learned.combo} learned in ${app.id}`)
  if (cfg.journal)
    journal.add({ kind: 'shortcut', text: `${learned.combo} (${learned.action}, ${app.name})` })
}

// ---- Fatigue ----

function noteSignal(s: Parameters<FatigueTracker['note']>[0]): void {
  fatigue.note(s, Date.now())
  void maybePropose()
}

async function maybePropose(): Promise<void> {
  if (asking || !helpers().fatigue) return
  const p: Proposal | null = fatigue.propose(loadConfig(), Date.now())
  if (!p) return
  asking = true
  try {
    const yes = await requestConfirm({ summary: p.text, risk: 'low' })
    fatigue.answer(p.id, yes, Date.now())
    saveSoon()
    if (!yes) return
    if (p.patch) saveConfig(p.patch as Parameters<typeof saveConfig>[0])
    announce(p.done, { kind: 'status' })
    log('step', `fatigue proposal ${p.id} accepted`)
  } catch (e) {
    log('fail', `fatigue proposal failed: ${(e as Error).message}`)
  } finally {
    asking = false
  }
}

// ---- Error rescue ----

async function onWindowOpened(el: {
  name?: string
  role?: string
  rect?: { w: number; h: number }
}): Promise<void> {
  if (!helpers().errorRescue || !el.name) return
  let looks = titleLooksLikeError(el)
  let nodes: ElementNode[] = []
  const small = !el.rect || (el.rect.w <= DIALOG_MAX.w && el.rect.h <= DIALOG_MAX.h)
  if (!looks && !small) return
  nodes = await foregroundNodes(150)
  const text = dialogText(nodes)
  if (!looks) looks = textLooksLikeError(text)
  if (!looks || !offers.offer(el.name, Date.now())) return
  const app = appOf(await foreground())
  rescueDialog = { title: el.name, text, buttons: dialogButtons(nodes), app: app?.name }
  log('step', 'error rescue: offered help for an error dialog')
  announce(OFFER_TEXT, { kind: 'status' })
}

async function explainError(): Promise<string> {
  let d = offers.pending(Date.now()) ? rescueDialog : null
  offers.close()
  if (!d) {
    const w = await foreground()
    const nodes = await foregroundNodes(150)
    d = {
      title: w?.title ?? '',
      text: dialogText(nodes),
      buttons: dialogButtons(nodes),
      app: appOf(w)?.name
    }
  }
  if (!d.title && !d.text) return 'I can’t read an error message on the screen.'
  const cfg = helpers()
  const level = readingLevelFor(cfg, d.app)
  try {
    const { llm, model, effort } = getProvider('fast')
    const res = await llm.complete(
      {
        model,
        system: [{ text: RESCUE_SYSTEM, cacheable: true }],
        messages: [
          {
            role: 'user',
            content: rescueTurn({ ...d, levelLine: readingLevelLine(level) })
          }
        ],
        maxTokens: 220,
        effort
      },
      AbortSignal.timeout(RESCUE_TIMEOUT_MS)
    )
    return res.text.trim() || 'I couldn’t work out that message.'
  } catch (e) {
    log('fail', `error rescue: ${(e as Error).message}`)
    return 'I couldn’t reach the AI to explain that message.'
  }
}

// ---- What changed ----

async function captureState(): Promise<ScreenState | null> {
  const agent = getAgent()
  if (!agent) return null
  const [w, nodes, shot] = await Promise.all([
    foreground(),
    foregroundNodes(400),
    commands
      .capture(
        agent,
        { monitor: 'foreground', maxWidth: 320, quality: 50 },
        { timeoutMs: AGENT_TIMEOUT_MS }
      )
      .catch(() => null)
  ])
  const frame = shot?.frames[0]
  return {
    at: Date.now(),
    title: w?.title ?? '',
    process: w?.process,
    elements: elementsOf(nodes),
    gray: frame ? decodeGray(frame.data) : null
  }
}

/**
 * Takes the "before" for "what changed?" (a command is starting). Resolves once it is taken
 * (or failed); never rejects. Runs before queries and before 06's local grammar commands.
 */
export function markBaseline(): Promise<void> {
  if (!helpers().whatChanged) return Promise.resolve()
  return captureState()
    .then((s) => {
      if (s) baseline = s
    })
    .catch(() => {})
}

/** A local command waits this long at most for its baseline, then runs anyway. */
const BASELINE_WAIT_MS = 400

/** markBaseline, capped so a slow capture never holds a voice command back for long. */
export function markBaselineBriefly(waitMs = BASELINE_WAIT_MS): Promise<void> {
  return Promise.race([markBaseline(), new Promise<void>((r) => setTimeout(r, waitMs))])
}

async function whatChanged(): Promise<string> {
  const after = await captureState()
  if (!after) return 'I can’t look at the screen right now.'
  return describeChange(baseline, after)
}

// ---- Reading level ----

/** The prompt modifier line for the app in front (05 appends it to the turn); '' = standard. */
export function readingLevelPrompt(appId?: string | null): string {
  return readingLevelLineFor(helpers(), appId)
}

async function setReadingLevel(
  cmd: Extract<HelperCommand, { kind: 'reading-level' }>
): Promise<string> {
  const cfg = helpers()
  const app = cmd.here ? appOf(await foreground()) : null
  const current = readingLevelFor(cfg, app?.id)
  const level =
    cmd.level === 'simpler' || cmd.level === 'deeper' ? stepLevel(current, cmd.level) : cmd.level
  saveConfig({ helpers: readingLevelPatch(cfg, level, app?.id) })
  const where = app ? ` in ${app.name}` : ''
  if (level === current) return `I’m already using ${levelName(level)} explanations${where}.`
  return `OK, ${levelName(level)} explanations${where} from now on. Ask your question again for a new answer.`
}

// ---- Voice entry ----

const answer = (text: string): { mode: 'answer'; text: string } => ({ mode: 'answer', text })

function runUndo(n: number | 'task'): Promise<{ mode: 'answer'; text: string }> {
  return undoLast(n, {
    run: (actions) =>
      executeActions(actions, {
        origin: 'user-direct',
        userText: 'undo that',
        preview: false,
        refine: false
      })
  }).then(answer)
}

/**
 * Helper voice commands. Returns the response (or its promise) when handled, undefined to go
 * on with the normal chain. Every utterance also feeds the fatigue signals (when on).
 */
export function interceptHelpers(prompt: string): unknown | undefined {
  const cfg = helpers()
  const now = Date.now()
  if (cfg.fatigue) {
    for (const s of utteranceSignals(prompt, lastUtterance, now)) noteSignal(s)
    noteSignal('activity')
  }
  lastUtterance = { text: prompt, at: now }
  const cmd = parseHelperCommand(prompt)
  if (!cmd) return undefined
  switch (cmd.kind) {
    case 'focus-on':
      return focusOn({ region: cmd.region, level: cmd.level }).then(answer)
    case 'focus-off':
      return answer(focusOff())
    case 'undo':
      // Plain "undo that" long after Lumen acted is the app's own Ctrl+Z (06 grammar).
      if (cmd.that && !recentlyActed()) return undefined
      if (!cfg.undo) return undefined
      return runUndo(cmd.n)
    case 'undo-task':
      if (!cfg.undo)
        return answer('Undo for my actions is off. Turn it on in Settings, Smart helpers.')
      return runUndo('task')
    case 'what-changed':
      return cfg.whatChanged ? whatChanged().then(answer) : undefined
    case 'reading-level':
      return setReadingLevel(cmd).then(answer)
    case 'journal':
      if (!cfg.journal)
        return answer('The learning journal is off. Turn it on in Settings, Smart helpers.')
      return answer(summarize(journal.recent(cmd.range === 'today' ? 1 : 7), cmd.range))
    case 'explain-error':
      return cfg.errorRescue ? explainError().then(answer) : undefined
    case 'accept-offer':
      return cfg.errorRescue && offers.pending(now) ? explainError().then(answer) : undefined
    case 'shortcut-tips':
      coach.setMuted(!cmd.on)
      saveSoon()
      if (cmd.on && !cfg.shortcutCoach) saveConfig({ helpers: { shortcutCoach: true } })
      return answer(cmd.on ? 'Shortcut tips are on.' : 'OK, no more shortcut tips.')
    case 'quiet-mode': {
      const background = { ...loadConfig().agent.background, quiet: cmd.on }
      return patchConfig({ agent: { background } }).then(() =>
        answer(
          cmd.on
            ? 'Quiet mode is on. Finished background tasks wait in the Tasks list.'
            : 'Quiet mode is off. I’ll tell you when a background task finishes.'
        )
      )
    }
  }
}

// ---- Settings IPC data ----

export function coachStatus(): CoachStatus {
  const s = coach.snapshot()
  const f = fatigue.snapshot()
  return {
    learned: coach.learned().map((e) => ({ app: e.app, action: e.action, combo: e.combo })),
    tracking: Object.values(s.entries).filter((e) => !e.learned).length,
    answered: Object.entries(f.answers).map(([id, a]) => ({ id, answer: a!.answer }))
  }
}

export function resetCoach(): void {
  coach = new ShortcutCoach({ entries: {} }, coachOpts)
  fatigue = new FatigueTracker({ answers: {} })
  saveSoon()
}

export function journalStore(): JournalStore {
  return journal
}

// ---- Install ----

function wireAgent(): void {
  const agent = getAgent()
  if (!agent) return
  agent.onEvent('uia-event', (data) => {
    const d = data as {
      kind?: unknown
      element?: { name?: unknown; role?: unknown; rect?: unknown }
    } | null
    const el = d?.element
    const e = {
      name: typeof el?.name === 'string' ? el.name : undefined,
      role: typeof el?.role === 'string' ? el.role : undefined,
      rect: el?.rect as { w: number; h: number } | undefined
    }
    if (d?.kind === 'invoked') void onInvoked(e)
    else if (d?.kind === 'window-opened') void onWindowOpened(e)
  })
  agent.onEvent('key-combo', (data) => {
    const combo = (data as { combo?: unknown } | null)?.combo
    if (typeof combo === 'string') void onCombo(combo)
  })
  agent.onEvent('dwell-trigger', () => {
    if (helpers().fatigue) misfire.onDwellClick(Date.now())
  })
  agent.onEvent('agent-ready', () => {
    if (uiaEvents.wanted()) uiaEvents.push()
    if (keyComboEvents.wanted()) keyComboEvents.push()
  })
}

/** Call once at startup, after the agent is set. */
export function installHelpers(): void {
  if (installed) return
  installed = true
  const saved = loadState()
  coach = new ShortcutCoach(saved.shortcuts ?? { entries: {} }, coachOpts)
  fatigue = new FatigueTracker(saved.fatigue ?? { answers: {} })
  installFocus()
  installUndo()
  wireAgent()
  syncSubscriptions()
  onConfigPatched(() => syncSubscriptions())
  setBeforeLocalChange(() => markBaselineBriefly())
  bus.on('query.started', (e) => {
    const cfg = helpers()
    void markBaseline()
    if (cfg.journal && e.prompt.trim()) journal.add({ kind: 'question', text: e.prompt })
  })
  bus.on('lesson.done', (e) => {
    if (!e.completed || !helpers().journal) return
    const hit = skillRegistry()?.lesson(e.lessonId)
    if (!hit) return
    journal.add({ kind: 'lesson', title: hit.lesson.title })
    journal.add({ kind: 'app', name: hit.skill.name })
  })
}
