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
import { redactForLog } from '../../actions/redact'
import { writeAudit } from '../../audit/log'
import { announce } from '../../a11y'
import { bus } from '../../bus'
import { configPath, loadConfig } from '../../config'
import { mcpToolSet } from '../../connectors'
import type { McpTaskEnv } from '../../connectors/tools'
import { CREATE_FILE_TOOL, createFileHandler } from '../../docs-out/tool'
import { GRANTED_FILE_TOOLS, grantedFileHandlers, realGrantedPorts } from '../../files/granted'
import type { GateCtx } from '../../actions/policy'
import { recordSkillRun } from '../../skills'
import { log, type LogTag } from '../../logger'
import { windowOnlyContext } from '../../query/context'
import { allowsForeground, routineGuard } from '../../routines/preapproval'
import * as assistant from '../../windows/assistant'
import { inputLane } from '../input-lane'
import { raced, type ToolHandler, type ToolOutcome } from '../runner'
import { agentRunning, runAgentTask } from '../session'
import { allGuards, connectorDefsFor, skillEnvelope, type SkillEnvelope } from '../skill-envelope'
import { enabledSkill } from '../skill-tools'
import type { GuardHost } from '../skill-run'
import { fetchPage } from './fetch'
import { readGranted, type ReadResult } from './files'
import { MAX_CHILDREN, type SpawnTaskInput } from './tools'
import type { BgPorts, ForegroundAnswer } from './handlers'
import { BackgroundManager, type StartInput, type TaskControl } from './manager'
import { doneLine, noticeVerdict, PRESENT_MS } from './presence'
import { runBackground } from './run'
import { backgroundRunRecord, backgroundSkills, networkAllows } from './skills'
import { TaskStore } from './store'
import { transcripts } from '../transcript-hub'
import { subagentPool, subagentSettings, subagentTurn } from '../subagents/host'

const TURN_MAX_TOKENS = 2048
/** Observed text kept for the policy's injection check (newest last). */
const MAX_OBSERVED = 20_000

/**
 * lookup_howto (05 T36), loaded on first use (it pulls in the providers and the agent). A helper
 * spends its parent's paid-search budget.
 */
const lookupHowto =
  (budgetId?: string): ToolHandler =>
  async (input, ctx) =>
    (await import('../../howto')).howtoToolHandler(undefined, budgetId)(input, ctx)
const FOREGROUND_ASK_MS = 60_000
/** A connector confirm of a background task counts as a no after this (the cap keeps running). */
const UNATTENDED_CONFIRM_MS = 120_000

let store: TaskStore | null = null
let routineShapes: (routineId: string) => ActionShape[] | null = () => null
let turnActive = false
let afterTurn: string[] = []

const newId = (): string => `bg_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

const settings = (): ReturnType<typeof loadConfig>['agent']['background'] =>
  loadConfig().agent.background

const manager = new BackgroundManager({
  max: () => settings().max,
  run: (ctl) => runAndRecord(ctl),
  emit: (task) => bus.emit({ type: 'task.changed', task }),
  save: (task) => store?.save(task),
  remove: (id) => {
    store?.remove(id)
    transcripts().remove(id)
  },
  record: (id, e) => transcripts().background(id, e),
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

/** The background run a foreground request comes from: its user's words and its skills. */
export interface ForegroundSource {
  /** The user's own words for the task (the routine's or the root task's prompt). */
  userText: string
  /** Skills whose envelopes the task runs under (its own and its parent's). */
  skills: string[]
  /** May use the mouse without asking (a routine's pre-approval). */
  preapproved: boolean
  /** What the background task read so far (the policy's injection check). */
  observedText?: string
}

/**
 * The confirm text: the reason and steps were written by the background model (which may have
 * read attacker pages), so they are shown as the task's request, quoted, not as the user's.
 */
export function foregroundAskText(title: string, reason: string, steps: string[]): string {
  const n = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  const quote = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 200)
  return `Background task “${title}” asks to use the mouse for ~${n}. Its request (written by the task, not by you): “${quote(reason)}”. Steps: ${steps.map(quote).join('; ')}`
}

async function requestForeground(
  ctl: TaskControl,
  reason: string,
  steps: string[],
  signal: AbortSignal,
  source: ForegroundSource
): Promise<ForegroundAnswer> {
  const title = ctl.task().title
  const what = foregroundAskText(title, reason, steps)
  // A routine that may use the mouse without asking still gets the countdown below.
  let now = source.preapproved
  if (!now && !turnActive && !agentRunning() && !assistant.confirmPending()) {
    ctl.update({ phase: 'needs-foreground' })
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        settled = true
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
      settled = true
    } finally {
      if (timer) clearTimeout(timer)
      // Cancelled while the card was up: take it down, or it would catch the next yes / no.
      if (!settled && assistant.confirmPending()) assistant.dropConfirm()
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
  // The policy's userText is the user's own task; the request itself counts as observed text,
  // so a site or command that only the background model named stays "from the page".
  const res = await runAgentTask(prompt, windowOnlyContext(window), signal, {
    noSpawn: true,
    userText: source.userText,
    observedText: [
      source.observedText,
      `Background task request: ${reason}`,
      `Steps: ${steps.join('; ')}`
    ]
      .filter(Boolean)
      .join('\n'),
    ...(source.skills.length ? { underSkills: source.skills } : {})
  })
  const summary = res.mode === 'answer' ? (res.spoken ?? res.text) : 'Done.'
  return { status: 'done', summary }
}

// ---- spawn_task ----

async function spawnChild(
  parentId: string,
  input: SpawnTaskInput,
  signal: AbortSignal
): Promise<{ id: string; summary?: string; ok: boolean }> {
  // A helper runs under its parent's rules: a routine's child is a routine run too (same
  // pre-approvals), and a skill run's child keeps the parent's skill envelope (runTask).
  const parent = manager.get(parentId)
  const child = manager.start({
    prompt: input.prompt,
    ...(input.skill ? { skill: input.skill } : {}),
    origin: parent?.origin === 'routine' ? 'routine' : 'agent',
    ...(parent?.routineId ? { routineId: parent.routineId } : {}),
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
  task: BackgroundTask,
  action: Record<string, unknown>,
  result: 'ok' | 'error' | 'denied',
  reason?: string
): void {
  writeAudit(backgroundAuditEntry(task, action, result, reason, new Date()))
}

type AuditEntry = Parameters<typeof writeAudit>[0]

/** One background audit line: the task's real origin, URLs, paths and reasons redacted. */
export function backgroundAuditEntry(
  task: Pick<BackgroundTask, 'id' | 'origin'>,
  action: Record<string, unknown>,
  result: 'ok' | 'error' | 'denied',
  reason: string | undefined,
  now: Date
): AuditEntry {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(action))
    clean[k] = typeof v === 'string' && (k === 'url' || k === 'path') ? redactForLog(v) : v
  return {
    t: now.toISOString(),
    task: `background:${task.id}`,
    origin: task.origin === 'routine' ? 'routine' : 'agent',
    action: clean as AuditEntry['action'],
    risk: 'low',
    decision: result === 'denied' ? 'blocked' : 'auto',
    result,
    ms: 0,
    ...(reason ? { reason: redactForLog(reason) } : {})
  }
}

/**
 * The skill envelopes a task runs under: its own skill's and, for a helper, its parent's.
 * A string: why the task cannot run (a skill is off or gone).
 */
function envelopesFor(task: BackgroundTask, host: GuardHost): SkillEnvelope[] | string {
  const parent = task.parentId ? manager.get(task.parentId) : null
  const names = [...new Set([task.skill, parent?.skill].filter((n): n is string => !!n))]
  const out: SkillEnvelope[] = []
  for (const name of names) {
    const s = enabledSkill(name)
    if (!s) return `The skill "${name}" is not installed or is off.`
    out.push(skillEnvelope(s, `background:${task.id}`, host))
  }
  return out
}

/** read_file inside the user's folders plus each envelope's own folders (every one must allow). */
export function readUnder(
  path: string,
  base: readonly string[],
  envelopes: readonly Pick<SkillEnvelope, 'readRoots'>[]
): ReadResult {
  if (!envelopes.length) return readGranted(path, base)
  let last: ReadResult = { ok: false, error: 'E_DENIED: no folders are granted.' }
  for (const e of envelopes) {
    last = readGranted(path, [...base, ...e.readRoots])
    if (!last.ok) return last
  }
  return last
}

/**
 * The policy gate's "user's words" for a task: a helper's own prompt was written by its
 * parent's model, so the root's words count; an automation's prompt also holds the fenced name
 * of the file that started it, so its own text (`userText`) counts, not the whole prompt.
 */
export function policyUserText(
  task: Pick<BackgroundTask, 'prompt' | 'userText'>,
  parent?: Pick<BackgroundTask, 'prompt' | 'userText'> | null
): string {
  const root = parent ?? task
  return root.userText ?? root.prompt
}

/** runTask, plus a run-history entry when the task runs a named skill. */
async function runAndRecord(ctl: TaskControl): ReturnType<typeof runTask> {
  const skill = ctl.task().skill
  const startedAt = Date.now()
  try {
    const r = await runTask(ctl)
    if (skill) recordSkillRun(skill, backgroundRunRecord(r, startedAt, Date.now()))
    return r
  } catch (e) {
    const end = { error: e as Error, cancelled: ctl.signal.aborted }
    if (skill) recordSkillRun(skill, backgroundRunRecord(end, startedAt, Date.now()))
    throw e
  }
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
  const parent = task.parentId ? manager.get(task.parentId) : null
  const userText = policyUserText(task, parent)
  const unattended = { timeoutMs: UNATTENDED_CONFIRM_MS, present: () => idleMs() < PRESENT_MS }
  // What the task read (pages, files, connector results) for the policy's injection check. A
  // prompt that holds more than the user's words (a fenced file name, a parent's wording) starts it.
  const seen: McpTaskEnv & { observedText: string } = {
    taskId: id,
    prompt: userText,
    observedText: task.prompt === userText ? '' : task.prompt,
    unattended
  }
  const observe = (text: string): void => {
    seen.observedText = `${seen.observedText}\n${text}`.slice(-MAX_OBSERVED)
  }
  const host: GuardHost = {
    speak: (text) => notice(`${task.title}: ${text}`),
    // Confirm-every-action skills: the question waits in the Tasks list.
    confirm: async (text, signal) => {
      notice(`Task “${task.title}” needs your OK. It waits in the Tasks list.`)
      // The signal withdraws the question when the caller stops (a helper's time limit).
      const a = await raced(
        ctl.ask(`${text}. Allow it?`, ['Allow', 'Deny'], 'asking', signal),
        signal
      )
      return /^(allow|yes|ok|okay|sure)\b/i.test(a.trim())
    }
  }
  const envelopes = envelopesFor(task, host)
  if (typeof envelopes === 'string') return { status: 'failed', summary: envelopes }
  // A skill run may only reach the sites every envelope lists, on every redirect hop too.
  const reaches = (url: string): boolean => envelopes.every((e) => networkAllows(e.network, url))
  const ports: BgPorts = {
    taskId: id,
    child: !!task.parentId,
    fetch: async (url, signal) => {
      if (!envelopes.length) return fetchPage(url, signal)
      if (!reaches(url))
        throw Object.assign(new Error(`E_DENIED: the skill may not open ${url}`), {
          code: 'E_DENIED'
        })
      return fetchPage(url, signal, undefined, reaches)
    },
    readFile: (path) => readUnder(path, cfg.readFolders, envelopes),
    memorySearch: (input) => memorySearchFor(input),
    // A skill run reaches only its own sites, so it gets no web lookups.
    ...(envelopes.length ? {} : { howto: lookupHowto(task.parentId) }),
    memoryWrite: (fact) => {
      if (isSensitive(fact)) return 'rejected'
      const r = memory().remember(fact, { layer: 'working' })
      return r === 'disabled' ? 'disabled' : r === 'rejected' ? 'rejected' : 'ok'
    },
    notify: (text) => notice(`${task.title}: ${text}`),
    ask: (question, choices, signal) => {
      notice(`Task “${task.title}” has a question. It waits in the Tasks list.`)
      return raced(ctl.ask(question, choices, 'asking', signal), signal)
    },
    requestForeground: (reason, steps, signal) =>
      requestForeground(ctl, reason, steps, signal, {
        userText,
        observedText: seen.observedText,
        skills: envelopes.map((e) => e.skill),
        preapproved: !!shapes && allowsForeground(shapes)
      }),
    spawn: (input, signal) => spawnChild(id, input, signal),
    childCount: () => manager.childCount(id),
    progress: (line) => ctl.progress(line),
    audit: (action, result, reason) => audit(task, action, result, reason)
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
    // Sub-agents (08 T49): the skill's model role when it names one, else Settings' choice.
    subagents: {
      pool: subagentPool(),
      turn: subagentTurn(skills.skill?.role ?? subagentSettings().model),
      costOf: (m, u) => usageCost(m, u).total,
      now: () => Date.now(),
      costCapUsd: subagentSettings().costCapUsd
    },
    skills: {
      ...skills,
      ...(skills.skill ? { skill: { name: skills.skill.name, text: skills.skill.text } } : {})
    },
    log: (tag, msg) => log(tag as LogTag, `[${id}] ${msg}`),
    // Connector tools; every call goes through the policy gate with origin "mcp". A skill run
    // gets only the servers every envelope lists.
    moreTools: async () => {
      // The connector handlers add their results to seen.observedText.
      const set = await mcpToolSet(seen)
      const defs = envelopes.reduce((d, e) => connectorDefsFor(d, e), set.defs)
      // File tools (docs-out, files/granted): the policy gate with this task's origin and
      // unattended confirms; reads, renames and moves only in the granted folders.
      const gateCtx = (): GateCtx => ({
        origin: task.origin === 'routine' ? 'routine' : 'agent',
        taskId: `background:${id}`,
        userText,
        observedText: seen.observedText,
        unattended
      })
      const granted = realGrantedPorts(
        () => cfg.readFolders,
        (action, result, reason) => audit(task, action, result, reason)
      )
      return {
        defs: [...defs, CREATE_FILE_TOOL, ...Object.values(GRANTED_FILE_TOOLS)],
        handlers: {
          ...set.handlers,
          create_file: createFileHandler(gateCtx),
          ...grantedFileHandlers(() => granted, gateCtx)
        }
      }
    },
    observe,
    fileSkills: envelopes.map((e) => e.skill),
    ...(shapes ? { guard: routineGuard(shapes) } : {}),
    ...(envelopes.length
      ? {
          toolGuard: allGuards(envelopes.map((e) => e.guard)),
          offers: (tool: string) => envelopes.every((e) => e.offers(tool))
        }
      : {})
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
