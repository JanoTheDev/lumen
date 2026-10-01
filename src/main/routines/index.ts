// Automations (grown from routines, 08 T22, and proactive rules, 08 T23): wiring. A run is a
// background task with origin "routine" (agent-mode/background); its high-risk tool calls need
// the automation's pre-approval and it never takes the mouse and keyboard while the user is
// away. Everything stays on this PC (~/.ai-overlay/automations.json; routines.json and the
// proactive rules are imported once). Triggers run only while Lumen is open, except time
// triggers with "wake Lumen for this" (a Task Scheduler entry, installed build only).
import { app, ipcMain, net, powerMonitor } from 'electron'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import {
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { z } from 'zod'
import type {
  Automation,
  AutomationAction,
  AutomationDraft,
  AutomationsInfo,
  AutomationTrigger,
  AutomationView
} from '@shared/automations'
import type { ActionShape } from '@shared/routines'
import { getProvider } from '../ai/providers'
import { parseJsonAs } from '../ai/json'
import { getAgent } from '../agent/instance'
import { wantFocusEvents } from '../a11y/focus-events'
import { foregroundWindow } from '../actions/policy'
import {
  backgroundManager,
  notice,
  setRoutineShapes,
  startBackgroundTask,
  userBusy
} from '../agent-mode/background'
import { expandRoot, isRemoteOrDevicePath } from '../agent-mode/background/files'
import { taskTitle } from '../agent-mode/background/manager'
import { PRESENT_MS } from '../agent-mode/background/presence'
import { enabledSkill } from '../agent-mode/skill-tools'
import { configPath, loadConfig } from '../config'
import { autostartSupported } from '../first-run/autostart'
import { INVALID, safeParse } from '../ipc/validate'
import { onConfigPatched, patchConfig } from '../ipc/settings'
import { log } from '../logger'
import { listSkillSummaries } from '../skills'
import * as assistant from '../windows/assistant'
import * as homeWin from '../windows/home'
import {
  actionSchema,
  AUTOMATION_ID_RE,
  AutomationStore,
  triggerSchema,
  type Legacy
} from './automation-store'
import {
  DRAFT_SYSTEM,
  draftReplySchema,
  draftUserTurn,
  fromReply,
  makeDraft,
  preapprovalQuestion
} from './draft'
import { AutomationScheduler, type RunEnd } from './engine'
import { onAutomationRequest, onSecondLaunch, waitingAutomationRequests } from './instance'
import { parseAutomationUtterance, parseTriggerText, type ParseOpts } from './parse'
import { FOREGROUND_SHAPE, setPresence } from './preapproval'
import { WakeTasks } from './schtasks'
import { RoutineStore } from './store'
import { describeTrigger, isTimeTrigger } from './triggers'
import { AutomationWatchers } from './watchers'

export { claimAutomationInstance } from './instance'

const STARTED_NOTICE_MS = 4000
const DRAFT_TIMEOUT_MS = 15_000
const CONNECTOR_SHAPE: ActionShape = { tool: 'mcp__*' }
const MAX_READ_FOLDERS = 20
/** Task Scheduler reads the XML as UTF-16 with a byte order mark. */
const BOM = String.fromCharCode(0xfeff)

const newId = (): string => `au_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

let store: AutomationStore | null = null
let lastCreated: string | null = null
let knownIds = new Set<string>()

// ---- presence ----

function idleMs(): number {
  try {
    return powerMonitor.getSystemIdleTime() * 1000
  } catch {
    return 0
  }
}

/** The user is at the PC: own input in the last 2 minutes and not in quiet mode. */
export function userPresent(): boolean {
  return idleMs() < PRESENT_MS && !loadConfig().agent.background.quiet
}

// ---- runs ----

function detailLine(a: Automation, detail?: string): string {
  if (!detail) return ''
  if (a.trigger.kind === 'file')
    return `\n\n(This run was started because of the file "${detail}". It is in a folder read_file may read.)`
  return `\n\n(This run was started because ${detail}.)`
}

/** A reminder nobody is around to hear waits in the Tasks list (and on the tray badge). */
function queueReminder(a: Automation, say: string): string {
  const t = startBackgroundTask({
    prompt: say,
    title: a.name,
    origin: 'routine',
    routineId: a.id,
    run: async () => ({ status: 'done', summary: say })
  })
  return t.id
}

async function runAutomation(
  a: Automation,
  ctx: { via: string; detail?: string }
): Promise<RunEnd> {
  const act = a.action
  if (act.kind === 'remind') {
    if (userPresent()) {
      notice(act.say)
      return { result: 'done', summary: act.say }
    }
    return { result: 'done', summary: act.say, taskId: queueReminder(a, act.say) }
  }
  const prompt =
    (act.kind === 'task' ? act.prompt : act.prompt || `Run the skill “${act.skill}”.`) +
    detailLine(a, ctx.detail)
  const t = startBackgroundTask({
    prompt,
    title: a.name,
    origin: 'routine',
    routineId: a.id,
    ...(act.kind === 'skill' ? { skill: act.skill } : {})
  })
  log('plan', `automation ${a.id} (${ctx.via}) started task ${t.id}`)
  // The cancel window: a short visual notice, only for someone at the PC and not mid-turn.
  if (userPresent() && !userBusy())
    assistant.setStatus(
      'idle',
      `Automation “${a.name}” is running in the background. Cancel it in the Tasks list.`,
      undefined,
      STARTED_NOTICE_MS
    )
  const end = await backgroundManager().wait(t.id)
  const result = end.phase === 'done' ? 'done' : end.phase === 'failed' ? 'failed' : 'cancelled'
  return { result, summary: end.result?.summary, taskId: t.id }
}

// ---- folders ----

const sameFolder = (a: string, b: string): boolean =>
  resolve(a)
    .replace(/[\\/]+$/, '')
    .toLowerCase() ===
  resolve(b)
    .replace(/[\\/]+$/, '')
    .toLowerCase()

function granted(folder: string): boolean {
  return loadConfig().agent.background.readFolders.some((f) => {
    const root = expandRoot(f)
    return !!root && sameFolder(root, folder)
  })
}

async function shareFolder(folder: string): Promise<boolean> {
  if (granted(folder)) return true
  const bg = loadConfig().agent.background
  if (bg.readFolders.length >= MAX_READ_FOLDERS) return false
  const saved = await patchConfig({
    agent: { background: { ...bg, readFolders: [...bg.readFolders, folder] } }
  })
  return !!saved && !('error' in saved)
}

const KNOWN_FOLDERS: Record<string, Parameters<typeof app.getPath>[0]> = {
  downloads: 'downloads',
  download: 'downloads',
  documents: 'documents',
  docs: 'documents',
  desktop: 'desktop',
  pictures: 'pictures',
  photos: 'pictures',
  images: 'pictures',
  music: 'music',
  videos: 'videos'
}

export function resolveFolder(name: string): string | null {
  const n = name
    .trim()
    .replace(/^(?:my|the) /i, '')
    .replace(/ folder$/i, '')
  const known = KNOWN_FOLDERS[n.toLowerCase()]
  try {
    if (known) return app.getPath(known)
    const p = expandRoot(n)
    if (!p || !isAbsolute(p) || isRemoteOrDevicePath(p)) return null
    if (!existsSync(p) || !statSync(p).isDirectory()) return null
    return realpathSync.native(p)
  } catch {
    return null
  }
}

const parseOpts = (): ParseOpts => ({ now: Date.now(), resolveFolder })

// ---- the scheduler, watchers and wake tasks ----

const wake = new WakeTasks({
  supported: () => autostartSupported(),
  exe: () => process.execPath,
  exec: (args) =>
    new Promise((res, rej) =>
      execFile('schtasks.exe', args, { windowsHide: true, timeout: 15_000 }, (err, out) =>
        err ? rej(err) : res(String(out))
      )
    ),
  writeXml: (id, xml) => {
    const path = join(tmpdir(), `lumen-wake-${id}.xml`)
    writeFileSync(path, `${BOM}${xml}`, 'utf16le')
    return path
  },
  removeXml: (path) => rmSync(path, { force: true }),
  now: () => Date.now(),
  log: (msg) => log('fail', msg)
})

const engine = new AutomationScheduler({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  run: runAutomation,
  save: (list) => store?.save(list),
  disabled: (a) => {
    log('fail', `automation ${a.id} turned off after repeated failures`)
    notice(`Automation “${a.name}” failed three times in a row, so I turned it off.`)
  },
  changed: () => afterChange(),
  newId,
  external: (a) => wake.active(a.id)
})

function processes(): Promise<string[]> {
  return new Promise((res, rej) =>
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) =>
        err
          ? rej(err)
          : res(
              String(out)
                .split(/\r?\n/)
                .map((l) => /^"([^"]+)"/.exec(l)?.[1] ?? '')
                .filter(Boolean)
            )
    )
  )
}

const watchers = new AutomationWatchers({
  focus: (on) => wantFocusEvents('automations', on),
  foreground: () => foregroundWindow(),
  processes,
  watchFolder: (folder, cb) => {
    let w: FSWatcher
    try {
      w = watch(folder, { persistent: false }, (_ev, name) => cb(name ? String(name) : null))
    } catch {
      return null
    }
    w.on('error', (e) => log('fail', `automation folder watch: ${e.message}`))
    return () => w.close()
  },
  listFolder: (folder) => {
    try {
      return readdirSync(folder)
    } catch {
      return null
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  granted,
  idleMs,
  online: () => net.isOnline(),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  fire: (id, detail) => {
    if (engine.fireEvent(id, detail)) log('plan', `automation ${id} triggered: ${detail ?? ''}`)
  }
})

function afterChange(): void {
  const list = engine.all()
  const ids = new Set(list.map((a) => a.id))
  const removed = [...knownIds].filter((id) => !ids.has(id))
  knownIds = ids
  watchers.sync(list)
  void wake.sync(list, removed).then(() => engine.replan())
}

export function automations(): AutomationScheduler {
  return engine
}

/** Kept for older importers. */
export const routines = automations

// ---- voice ----

const answer = (text: string): { mode: 'answer'; text: string; spoken: string } => ({
  mode: 'answer',
  text,
  spoken: text
})

const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const REMOVE_LAST_RE =
  /^(?:delete|remove|cancel|undo|stop) (?:that|the last|this) (?:new )?(?:automation|routine|reminder)$/
const LIST_RE =
  /^(?:what|which) (?:automations|routines) (?:do i have|are there|are set up)$|^list (?:my )?(?:automations|routines)$/
/** Clearly an automation request the grammar could not read: the fast model drafts it. */
const MODEL_INTENT_RE =
  /^(?:please )?(?:create|add|make|set up|setup|new) (?:an? |me an? )?(?:new )?(?:automation|routine)\b|\bautomatically\b/

const title = (s: string): string => taskTitle(s)

function draftFor(trigger: AutomationTrigger, action: AutomationAction): AutomationDraft {
  return makeDraft(trigger, action, title, granted)
}

async function modelDraft(text: string): Promise<AutomationDraft | { error: string }> {
  try {
    const skills = listSkillSummaries()
      .filter((s) => s.enabled)
      .map((s) => s.name)
    const { llm, model, effort } = getProvider('fast')
    const res = await llm.complete(
      {
        model,
        system: [{ text: DRAFT_SYSTEM, cacheable: true }],
        messages: [{ role: 'user', content: draftUserTurn(text, skills, Date.now()) }],
        maxTokens: 400,
        effort,
        schema: draftReplySchema,
        schemaName: 'automation_draft'
      },
      AbortSignal.timeout(DRAFT_TIMEOUT_MS)
    )
    const reply = res.data ?? parseJsonAs(res.text, draftReplySchema)
    if (!reply) return { error: 'I could not turn that into an automation.' }
    const r = fromReply(reply, parseOpts(), (name) => !!enabledSkill(name))
    return r.ok ? draftFor(r.trigger, r.action) : { error: r.reason }
  } catch (e) {
    log('fail', `automation draft: ${(e as Error).message}`)
    return { error: 'I could not reach the AI to set that up. Try “every weekday at 9 …”.' }
  }
}

function shapesFor(foreground: boolean, connectors: boolean): ActionShape[] {
  return [...(foreground ? [FOREGROUND_SHAPE] : []), ...(connectors ? [CONNECTOR_SHAPE] : [])]
}

async function save(
  d: Pick<AutomationDraft, 'name' | 'trigger' | 'action'>,
  shapes: ActionShape[]
): Promise<Automation | string> {
  if (d.trigger.kind === 'file' && !(await shareFolder(d.trigger.folder)))
    return 'I could not share that folder; remove one in Settings, Automations first.'
  const a = engine.add({ name: d.name, trigger: d.trigger, action: d.action, preApproved: shapes })
  return a ?? 'You have too many automations; remove one in Settings first.'
}

/** The confirm card, then the pre-approval question, then save. */
async function confirmAndCreate(draft: AutomationDraft): Promise<unknown> {
  const yes = await assistant.requestConfirm({
    summary: `Create this automation? ${draft.summary}`,
    risk: 'low'
  })
  if (!yes) return answer('Okay, I didn’t set it up.')
  const q = preapprovalQuestion(draft.wants)
  let shapes: ActionShape[] = []
  if (q) {
    const allow = await assistant.requestConfirm({ summary: q, risk: 'medium' })
    shapes = allow ? shapesFor(draft.wants.foreground, draft.wants.connectors) : []
  }
  const a = await save(draft, shapes)
  if (typeof a === 'string') return answer(a)
  lastCreated = a.id
  const when = describeTrigger(a.trigger)
  return answer(
    `Okay, ${when}${a.action.kind === 'remind' ? ' I’ll remind you' : ' it runs in the background'}. Say “delete that automation” to undo it.`
  )
}

/** Whole-utterance automation commands; undefined = not ours. */
export function interceptRoutines(prompt: string): unknown | undefined {
  const w = words(prompt)
  if (REMOVE_LAST_RE.test(w)) {
    const a = lastCreated ? engine.get(lastCreated) : null
    if (!a) return answer('There is no new automation to remove.')
    engine.remove(a.id)
    lastCreated = null
    return answer(`Removed the automation “${a.name}”.`)
  }
  if (LIST_RE.test(w)) {
    const list = engine.list()
    if (!list.length) return answer('You have no automations yet.')
    return answer(
      list.map((a) => `- ${a.name}: ${a.triggerText}${a.enabled ? '' : ' (off)'}`).join('\n')
    )
  }
  const parsed = parseAutomationUtterance(prompt, parseOpts())
  if (parsed && !parsed.ok) {
    // The grammar knew it was meant as one but could not finish it: the model may.
    if (!MODEL_INTENT_RE.test(w)) return answer(parsed.reason)
  } else if (parsed?.ok) return confirmAndCreate(draftFor(parsed.trigger, parsed.action))
  if (!MODEL_INTENT_RE.test(w)) return undefined
  return modelDraft(prompt).then((d) => ('error' in d ? answer(d.error) : confirmAndCreate(d)))
}

export const interceptAutomations = interceptRoutines

// ---- IPC ----

const idSchema = z.string().regex(AUTOMATION_ID_RE)
const updateSchema = z
  .object({
    id: idSchema,
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    trigger: z.string().trim().min(2).max(200).optional(),
    text: z.string().trim().min(1).max(2000).optional(),
    allowForeground: z.boolean().optional(),
    allowConnectors: z.boolean().optional(),
    wake: z.boolean().optional(),
    catchUp: z.boolean().optional()
  })
  .strict()
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: triggerSchema,
    action: actionSchema,
    allowForeground: z.boolean(),
    allowConnectors: z.boolean()
  })
  .strict()

function problemFor(a: Automation): string | undefined {
  if (a.wake && isTimeTrigger(a.trigger) && !autostartSupported())
    return 'Waking Lumen needs the installed Lumen; it runs only while Lumen is open.'
  return watchers.problem(a.id) ?? (a.wake ? wake.error(a.id) : undefined)
}

function withText(action: AutomationAction, text: string): AutomationAction {
  if (action.kind === 'remind') return { kind: 'remind', say: text }
  if (action.kind === 'skill') return { ...action, prompt: text }
  return { kind: 'task', prompt: text }
}

async function update(raw: unknown): Promise<{ ok: boolean; error?: string } | typeof INVALID> {
  const u = safeParse('automations:update', updateSchema, raw)
  if (!u) return INVALID
  const a = engine.get(u.id)
  if (!a) return { ok: false, error: 'It is gone.' }
  let trigger = a.trigger
  if (u.trigger !== undefined) {
    const t = parseTriggerText(u.trigger, parseOpts())
    if (!t.ok) return { ok: false, error: t.reason }
    trigger = t.trigger
    if (trigger.kind === 'file' && !(await shareFolder(trigger.folder)))
      return { ok: false, error: 'That folder could not be shared.' }
  }
  let shapes = a.preApproved
  if (u.allowForeground !== undefined) {
    shapes = shapes.filter((s) => !(s.tool === FOREGROUND_SHAPE.tool && !s.args))
    if (u.allowForeground) shapes = [...shapes, FOREGROUND_SHAPE]
  }
  if (u.allowConnectors !== undefined) {
    shapes = shapes.filter((s) => !(s.tool === CONNECTOR_SHAPE.tool && !s.args))
    if (u.allowConnectors) shapes = [...shapes, CONNECTOR_SHAPE]
  }
  const ok = engine.update(u.id, {
    ...(u.enabled !== undefined ? { enabled: u.enabled } : {}),
    ...(u.name !== undefined ? { name: u.name } : {}),
    ...(u.trigger !== undefined ? { trigger } : {}),
    ...(u.text !== undefined ? { action: withText(a.action, u.text) } : {}),
    ...(u.wake !== undefined ? { wake: u.wake } : {}),
    ...(u.catchUp !== undefined ? { catchUp: u.catchUp } : {}),
    preApproved: shapes
  })
  return { ok }
}

export function registerRoutinesIpc(): void {
  ipcMain.handle('automations:list', (_e, ...args: unknown[]): AutomationView[] | typeof INVALID =>
    args.length ? INVALID : engine.list(problemFor)
  )
  ipcMain.handle('automations:info', (_e, ...args: unknown[]): AutomationsInfo | typeof INVALID =>
    args.length
      ? INVALID
      : {
          wakeSupported: autostartSupported(),
          skills: listSkillSummaries()
            .filter((s) => s.enabled)
            .map((s) => ({ name: s.name, description: s.description }))
        }
  )
  ipcMain.handle('automations:update', (_e, raw: unknown) => update(raw))
  ipcMain.handle('automations:remove', (_e, raw: unknown) => {
    const id = safeParse('automations:remove', idSchema, raw)
    if (id === undefined) return INVALID
    return { ok: engine.remove(id) }
  })
  ipcMain.handle('automations:run-now', (_e, raw: unknown) => {
    const id = safeParse('automations:run-now', idSchema, raw)
    if (id === undefined) return INVALID
    return { ok: engine.runNow(id) }
  })
  ipcMain.handle('automations:draft', async (_e, raw: unknown) => {
    const text = safeParse('automations:draft', z.string().trim().min(3).max(1000), raw)
    if (text === undefined) return INVALID
    // Typed in Settings: always meant as an automation.
    const parsed = parseAutomationUtterance(`create an automation ${text}`, parseOpts())
    if (parsed?.ok) return { ok: true, draft: draftFor(parsed.trigger, parsed.action) }
    const d = await modelDraft(text)
    return 'error' in d ? { ok: false, error: parsed?.reason ?? d.error } : { ok: true, draft: d }
  })
  ipcMain.handle('automations:create', async (_e, raw: unknown) => {
    const c = safeParse('automations:create', createSchema, raw)
    if (!c) return INVALID
    const trigger = c.trigger as AutomationTrigger
    const a = await save(
      { name: c.name, trigger, action: c.action as AutomationAction },
      shapesFor(c.allowForeground, c.allowConnectors)
    )
    return typeof a === 'string' ? { ok: false, error: a } : { ok: true, id: a.id }
  })
}

// ---- install ----

let installed = false

function readLegacy(dir: string): Legacy {
  const cfg = loadConfig().agent.proactive
  return {
    routines: new RoutineStore(join(dir, 'routines.json')).load(),
    proactive: { enabled: cfg.enabled, rules: cfg.rules }
  }
}

export function installRoutines(file = join(dirname(configPath()), 'automations.json')): void {
  if (installed) return
  installed = true
  const dir = dirname(file)
  store = new AutomationStore(file, () => readLegacy(dir))
  setRoutineShapes((id) => engine.get(id)?.preApproved ?? null)
  setPresence(userPresent)
  const list = store.load()
  knownIds = new Set(list.map((a) => a.id))
  // A one-off a wake task started Lumen for is not "missed": runWake runs it below.
  engine.start(list, { wakeIds: waitingAutomationRequests() })
  watchers.sync(engine.all())
  void wake.reconcile(engine.all()).then(() => engine.replan())
  onConfigPatched(() => watchers.sync(engine.all()))
  getAgent()?.onEvent('focus-changed', () => watchers.onFocusChanged())
  onAutomationRequest((id) => {
    const ok = engine.runWake(id)
    log('plan', `automation ${id} wake run ${ok ? 'started' : 'skipped'}`)
  })
  onSecondLaunch(() => homeWin.show())
  app?.on('will-quit', () => {
    engine.stop()
    watchers.stop()
  })
}
