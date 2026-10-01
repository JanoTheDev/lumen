// Background agents (08 T26–T30, skills-and-background-agents.md §2): the manager singleton
// wired to the providers (fast role, or the skill's model), the safety policy, memory, the
// assistant bar, presence-gated notices, persistence and the input lane for request_foreground.
import { app, powerMonitor } from 'electron'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import type { ActionShape } from '@shared/routines'
import type { BackgroundTask } from '@shared/types'
import { usageCost } from '../../ai/pricing'
import { getProvider } from '../../ai/providers'
import type { Role } from '../../ai/models'
import { memory, memorySearchFor } from '../../ai/memory/runtime'
import { isSensitive } from '../../ai/memory'
import { requireAgent } from '../../agent/instance'
import { writeAudit } from '../../audit/log'
import { announce } from '../../a11y'
import { bus } from '../../bus'
import { configPath, loadConfig } from '../../config'
import { log, type LogTag } from '../../logger'
import { windowOnlyContext } from '../../query/context'
import { allowsForeground, routineGuard } from '../../routines/preapproval'
import * as assistant from '../../windows/assistant'
import { inputLane } from '../input-lane'
import { raced, type ToolHandler, type ToolOutcome } from '../runner'
import { agentRunning, runAgentTask } from '../session'
import { fetchPage } from './fetch'
import { readGranted } from './files'
import { MAX_CHILDREN, type SpawnTaskInput } from './tools'
import type { BgPorts, ForegroundAnswer } from './handlers'
import { BackgroundManager, type StartInput, type TaskControl } from './manager'
import { doneLine, noticeVerdict } from './presence'
import { runBackground } from './run'
import { backgroundSkills, networkAllows } from './skills'
import { TaskStore } from './store'

const TURN_MAX_TOKENS = 2048
const FOREGROUND_ASK_MS = 60_000

let store: TaskStore | null = null
let routineShapes: (routineId: string) => ActionShape[] | null = () => null
let turnActive = false
let afterTurn: string[] = []

const newId = (): string => `bg_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

const settings = (): ReturnType<typeof loadConfig>['agent']['background'] =>
  loadConfig().agent.background

const manager = new BackgroundManager({
  max: () => settings().max,
  run: (ctl) => runTask(ctl),
  emit: (task) => bus.emit({ type: 'task.changed', task }),
  save: (task) => store?.save(task),
  remove: (id) => store?.remove(id),
  finished: (task) => {
    if (task.phase !== 'done' && task.phase !== 'failed') return
    notice(doneLine(task.title, task.phase, task.result?.summary ?? ''))
  },
  now: () => Date.now(),
  newId
})

export function backgroundManager(): BackgroundManager {
  return manager
}

/** Starts a background task (voice "in the background …", a routine, a skill run). */
export function startBackgroundTask(input: StartInput): BackgroundTask {
  const t = manager.start(input)
  log('plan', `background task ${t.id} ${t.phase}: "${t.title}"`)
  return t
}

/** Routines (08 T22) tell the runner which tool calls a routine pre-approved. */
export function setRoutineShapes(fn: (routineId: string) => ActionShape[] | null): void {
  routineShapes = fn
}

// ---- notices (presence rule) ----

function idleMs(): number {
  try {
    return powerMonitor.getSystemIdleTime() * 1000
  } catch {
    return 0
  }
}

/** A spoken line under the presence rule (now, after the user's turn, or list only). */
export function notice(text: string): void {
  const v = noticeVerdict({
    idleMs: idleMs(),
    quiet: settings().quiet,
    midTurn: turnActive || assistant.confirmPending()
  })
  if (v === 'now') announce(text, { kind: 'status', priority: 'polite' })
  else if (v === 'after-turn') afterTurn.push(text)
}

/** The user is in a turn of their own, a confirm, or a foreground agent task. */
export function userBusy(): boolean {
  return turnActive || agentRunning() || assistant.confirmPending()
}

function turnEnded(): void {
  turnActive = false
  const queued = afterTurn
  afterTurn = []
  // A little later, so the turn's own answer is heard first.
  if (queued.length) setTimeout(() => queued.forEach(notice), 1500)
}

// ---- request_foreground ----

async function requestForeground(
  ctl: TaskControl,
  reason: string,
  steps: string[],
  signal: AbortSignal,
  preapproved = false
): Promise<ForegroundAnswer> {
  const title = ctl.task().title
  const what = `Task “${title}” wants to use the mouse for ~${steps.length} ${steps.length === 1 ? 'step' : 'steps'}: ${reason}`
  // A routine that may use the mouse without asking still gets the countdown below.
  let now = preapproved
  if (!now && !turnActive && !agentRunning() && !assistant.confirmPending()) {
    ctl.update({ phase: 'needs-foreground' })
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        assistant.dropConfirm()
        resolve(false)
      }, FOREGROUND_ASK_MS)
    })
    try {
      now = await raced(
        Promise.race([
          assistant.requestConfirm({ summary: `${what}. Do it now?`, risk: 'medium' }),
          timeout
        ]),
        signal
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (!now) {
    // "Later": waits in the Tasks list with Do it now / Cancel.
    const a = await ctl.ask(`${what}.`, ['Do it now', 'Cancel'], 'needs-foreground')
    if (!/^(do it|yes|now|ok)/i.test(a)) return { status: 'cancelled' }
  }
  ctl.update({ phase: 'running', question: undefined })
  if (agentRunning() || inputLane().holderName()) return { status: 'busy' }
  ctl.progress('Working on screen')
  const prompt = `${reason}. Steps: ${steps.join('; ')}. (For the background task “${title}”.)`
  const window = await requireAgent()
    .activeWindow()
    .catch(() => '')
  const res = await runAgentTask(prompt, windowOnlyContext(window), signal, { noSpawn: true })
  const summary = res.mode === 'answer' ? (res.spoken ?? res.text) : 'Done.'
  return { status: 'done', summary }
}

// ---- spawn_task ----

async function spawnChild(
  parentId: string,
  input: SpawnTaskInput,
  signal: AbortSignal
): Promise<{ id: string; summary?: string; ok: boolean }> {
  const child = manager.start({
    prompt: input.prompt,
    ...(input.skill ? { skill: input.skill } : {}),
    origin: 'agent',
    parentId,
    immediate: !!input.wait
  })
  if (!input.wait) return { id: child.id, ok: true }
  const onAbort = (): void => void manager.cancel(child.id)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const end = await raced(manager.wait(child.id), signal)
    return { id: child.id, ok: end.phase === 'done', summary: end.result?.summary }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** spawn_task for foreground agent mode (its children are background tasks). */
export function foregroundSpawnHandler(parentId: string): ToolHandler {
  return async (raw, ctx): Promise<ToolOutcome> => {
    const input = raw as SpawnTaskInput
    const text = (t: string): ToolOutcome['content'] => [{ type: 'text', text: t }]
    if (manager.childCount(parentId) >= MAX_CHILDREN)
      return { content: text(`E_DENIED: at most ${MAX_CHILDREN} helper tasks.`), isError: true }
    const r = await spawnChild(parentId, input, ctx.signal)
    if (!input.wait) return { content: text(`Started helper task ${r.id} in the background.`) }
    return r.ok
      ? { content: text(`Helper ${r.id} finished: ${r.summary ?? ''}`) }
      : { content: text(`Helper ${r.id} did not finish: ${r.summary ?? ''}`), isError: true }
  }
}

// ---- one run ----

function audit(
  id: string,
  action: Record<string, unknown>,
  result: 'ok' | 'error' | 'denied',
  reason?: string
): void {
  writeAudit({
    t: new Date().toISOString(),
    task: `background:${id}`,
    origin: 'agent',
    action,
    risk: 'low',
    decision: result === 'denied' ? 'blocked' : 'auto',
    result,
    ms: 0,
    ...(reason ? { reason } : {})
  })
}

async function runTask(
  ctl: TaskControl
): Promise<{ status: 'done' | 'failed'; summary: string; report?: string }> {
  const task = ctl.task()
  const id = task.id
  const skills = backgroundSkills(task.skill, (name) => ctl.progress(`Using skill ${name}`))
  if (skills.missing) return { status: 'failed', summary: skills.missing }
  const cfg = settings()
  const role: Role = skills.skill?.role ?? 'fast'
  // A routine run: high-risk calls only when pre-approved (a run whose routine is gone: none).
  const shapes = task.origin === 'routine' ? (routineShapes(task.routineId ?? '') ?? []) : null
  const network = skills.skill?.network
  const ports: BgPorts = {
    taskId: id,
    child: !!task.parentId,
    fetch: async (url, signal) => {
      // A skill run may only reach the sites its permissions list.
      if (network && !networkAllows(network, url))
        throw Object.assign(new Error(`E_DENIED: the skill may not open ${url}`), {
          code: 'E_DENIED'
        })
      return fetchPage(url, signal)
    },
    readFile: (path) => readGranted(path, [...cfg.readFolders, ...(skills.skill?.readRoots ?? [])]),
    memorySearch: (input) => memorySearchFor(input),
    memoryWrite: (fact) => {
      if (isSensitive(fact)) return 'rejected'
      const r = memory().remember(fact, { layer: 'working' })
      return r === 'disabled' ? 'disabled' : r === 'rejected' ? 'rejected' : 'ok'
    },
    notify: (text) => notice(`${task.title}: ${text}`),
    ask: (question, choices, signal) => {
      notice(`Task “${task.title}” has a question. It waits in the Tasks list.`)
      return raced(ctl.ask(question, choices), signal)
    },
    requestForeground: (reason, steps, signal) =>
      requestForeground(ctl, reason, steps, signal, !!shapes && allowsForeground(shapes)),
    spawn: (input, signal) => spawnChild(id, input, signal),
    childCount: () => manager.childCount(id),
    progress: (line) => ctl.progress(line),
    audit: (action, result, reason) => audit(id, action, result, reason)
  }
  return runBackground(ctl, {
    caps: {
      maxModelCalls: cfg.maxModelCalls,
      maxCostUsd: cfg.maxCostUsd,
      maxWallMs: cfg.maxWallMin * 60_000
    },
    ports,
    turn: (req, signal) => {
      const { llm, model, effort } = getProvider(role)
      if (!llm.toolTurn)
        throw new Error(
          'Background tasks need an Anthropic or OpenAI key (the local model has no tool use).'
        )
      return llm.toolTurn({ ...req, model, effort, maxTokens: TURN_MAX_TOKENS }, signal)
    },
    costOf: (m, u) => usageCost(m, u).total,
    now: () => Date.now(),
    skills: {
      ...skills,
      ...(skills.skill ? { skill: { name: skills.skill.name, text: skills.skill.text } } : {})
    },
    log: (tag, msg) => log(tag as LogTag, `[${id}] ${msg}`),
    ...(shapes ? { guard: routineGuard(shapes) } : {})
  })
}

// ---- install ----

let installed = false

/** Loads earlier tasks (open ones become interrupted) and marks running ones on quit. */
export function installBackground(dir = join(dirname(configPath()), 'tasks')): void {
  if (installed) return
  installed = true
  store = new TaskStore(dir)
  manager.restore(store.load())
  bus.on('query.started', () => (turnActive = true))
  bus.on('query.done', turnEnded)
  bus.on('query.failed', turnEnded)
  bus.on('query.cancelled', turnEnded)
  app?.on('before-quit', () => manager.interruptAll())
}
