// Foreground agent mode: one task at a time, started by the query pipeline for multi-step
// requests. Wires the runner to the providers (planning role for the plan, main role for the
// tool loop), the assistant bar (state, countdown, cap confirm), speech and the voice
// commands that only apply while a task runs ("go", "stop", "wait", answers, "resume the task").
import type { AgentTask } from '@shared/events'
import type { ModelResponse, SkillRunRecord } from '@shared/types'
import { newTaskState } from '../actions/safety'
import { usageCost } from '../ai/pricing'
import { getProvider } from '../ai/providers'
import { skillContext } from '../ai/skills'
import { announce } from '../a11y'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log, type LogTag } from '../logger'
import type { QueryContext } from '../query/context'
import { replyLanguageLine } from '../speech/language'
import { withCancelArmed } from '../speech/wake/arm'
import * as assistant from '../windows/assistant'
import { setStatus } from '../windows/status'
import { answerQuestion, askPending, type AskIo } from './ask'
import { createHandlers, type TaskEnv } from './handlers'
import { inputLane } from './input-lane'
import { PLAN_SYSTEM, normalizePlan, planSchema, planTurn, type TaskContext } from './prompts'
import {
  runAgent,
  type RunnerDeps,
  type RunnerModel,
  type RunResult,
  type SavedRun,
  type ToolHandler
} from './runner'
import { FOREGROUND_TOOLS } from './tools'
import { foregroundSpawnHandler } from './background'
import { BG_TOOLS } from './background/tools'
import { enabledSkill, preloadSkill, skillToolSet, type SkillToolSet } from './skill-tools'
import {
  afterDrift,
  finishSkillRun,
  runStepsForeground,
  type SkillHost,
  type ToolGuard
} from './skill-run'
import {
  connectorDefsFor,
  joinEnvelopes,
  skillEnvelope,
  type SkillEnvelope
} from './skill-envelope'
import { traceRecorder, type RunTrace } from './trace'
import { rememberAgentRun } from '../skills/creation'
import type { LoadedSkill } from '../skills/registry'
import { MEMORY_SEARCH_TOOL, memorySearchInput } from '../ai/memory/search'
import type { ToolDef } from '../ai/providers/types'
import { mcpToolSet } from '../connectors'
import { memorySearchFor } from '../ai/memory/runtime'
import { observed } from './prompts'
import { CancelledError } from '../query/cancel'
import { takeFilesFor } from '../files/attach'
import { transcripts } from './transcript-hub'

const PAUSE_KEEP_MS = 10 * 60_000
const TURN_MAX_TOKENS = 2048
const PLAN_MAX_TOKENS = 600

let running: { taskId: string; abort: () => void } | null = null
let countdownAnswer: ((r: 'go' | 'cancel') => void) | null = null
/** What a paused run needs to go on exactly as before (a skill run keeps its envelope). */
interface PausedRun {
  saved: SavedRun
  env: TaskEnv
  context: TaskContext
  until: number
  envelope?: SkillEnvelope
  noSpawn?: boolean
}

let paused: PausedRun | null = null

/** A task is running (or counting down / asking). */
export function agentRunning(): boolean {
  return !!running
}

/** The running foreground task's id (the task chat view steers and stops it). */
export function runningAgentTaskId(): string | null {
  return running?.taskId ?? null
}

/** Stops the running task if it is `id`. */
export function stopAgentTask(id: string): boolean {
  if (running?.taskId !== id) return false
  running.abort()
  return true
}

/** A task paused on an unanswered question that "resume the task" can continue. */
export function hasPausedTask(now = Date.now()): boolean {
  if (paused && now > paused.until) paused = null
  return !!paused
}

const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(ok|okay|please|hey lumen|lumen)\s+/, '')
    .replace(/\s+please$/, '')
    .trim()

const GO_RE = /^(go|go ahead|go now|start|start now|do it now|now)$/
const STOP_RE = /^(stop|wait|no|cancel|abort|stop it|hold on|not now|don t)$/
const RESUME_RE = /^(resume|resume the task|continue the task|carry on|keep going|continue)$/

export function isResumeRequest(utterance: string): boolean {
  return RESUME_RE.test(words(utterance))
}

/**
 * Voice and typed input while a task runs, before normal routing: an answer to ask_user,
 * "go" / "stop" during the countdown, "stop" / "wait" / "no" while running. Returns true when
 * the utterance was used up here.
 */
export function interceptAgentUtterance(utterance: string): boolean {
  if (askPending()) return answerQuestion(utterance)
  // A confirm card (policy, cap, replace task) takes its own yes / no.
  if (!running || assistant.confirmPending()) return false
  const w = words(utterance)
  if (countdownAnswer) {
    if (GO_RE.test(w)) {
      countdownAnswer('go')
      return true
    }
    if (STOP_RE.test(w)) {
      countdownAnswer('cancel')
      return true
    }
    return false
  }
  if (STOP_RE.test(w)) {
    running.abort()
    return true
  }
  return false
}

/** Bar buttons: skip the countdown, or answer the question with a choice. */
export function agentCommand(cmd: { type: 'go' } | { type: 'answer'; text: string }): boolean {
  if (cmd.type === 'go') {
    if (!countdownAnswer) return false
    countdownAnswer('go')
    return true
  }
  return answerQuestion(cmd.text)
}

// ---- runner wiring ----

function taskContext(ctx: QueryContext, prompt: string): TaskContext {
  // Dropped files (08 T21): listed, and read_file offered, only when the task is about them.
  const files = takeFilesFor(prompt)
  const skill = ctx.skill
    ? { name: ctx.skill.name, text: skillContext(ctx.skill, prompt) }
    : undefined
  return {
    window: ctx.activeWindow,
    app: ctx.foreground.process,
    ...(skill?.text ? { skill } : {}),
    language: replyLanguageLine(loadConfig().voice.language),
    now: new Date(),
    ...(files.length ? { files: files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })) } : {})
  }
}

const model: RunnerModel = {
  async plan(prompt, ctx, signal) {
    const { llm, model, effort } = getProvider('planning')
    try {
      const res = await llm.complete(
        {
          model,
          system: [{ text: PLAN_SYSTEM, cacheable: true }],
          messages: [{ role: 'user', content: planTurn(prompt, ctx) }],
          maxTokens: PLAN_MAX_TOKENS,
          effort,
          schema: planSchema,
          schemaName: 'lumen_agent_plan'
        },
        signal
      )
      return { plan: normalizePlan(res.data), model: res.model, usage: res.usage }
    } catch (e) {
      if (signal.aborted) throw e
      log('fail', `agent plan failed (${(e as Error).message}), going ahead without one`)
      return { plan: null }
    }
  },
  async turn(req, signal) {
    const { llm, model, effort } = getProvider('main')
    if (!llm.toolTurn)
      throw new Error(
        'Agent mode needs an Anthropic or OpenAI key (the local model has no tool use).'
      )
    return llm.toolTurn({ ...req, model, effort, maxTokens: TURN_MAX_TOKENS }, signal)
  }
}

let lastStatus = ''

/** Until the bar renders `agentTask` (03), the step shows on the status line. */
function showOnBar(task: AgentTask): void {
  bus.emit({ type: 'agent.task', task })
  const running = task.steps.find((s) => s.status === 'running')
  const index = running ? running.i : task.steps.filter((s) => s.status === 'done').length
  const step = task.steps.length
    ? { index: Math.max(1, index), total: task.steps.length }
    : undefined
  let line = ''
  switch (task.phase) {
    case 'planning':
      line = 'Planning…'
      break
    case 'countdown':
      line = `I'll ${task.summary}. Say "stop" to cancel or "go" to start now.`
      break
    case 'running':
      line = running?.label ?? task.summary
      break
    case 'asking':
      line = task.question?.choices?.length
        ? `${task.question.text} (${task.question.choices.join(' / ')})`
        : (task.question?.text ?? '')
      break
    case 'paused':
      line = 'Paused. Say "resume the task" to go on.'
      break
    default:
      return
  }
  if (line === lastStatus) return
  lastStatus = line
  setStatus(
    task.phase === 'planning' ? 'thinking' : task.phase === 'countdown' ? 'acting' : 'step',
    line,
    step
  )
}

const say = (text: string): void => announce(text, { kind: 'step', priority: 'assertive' })

/** Rough speaking time, so the microphone opens after the question was read out. */
const speakMs = (text: string): number => Math.min(6000, 600 + text.split(/\s+/).length * 330)

const askIo: AskIo = {
  speak: say,
  listen: () => {
    const q = lastQuestion
    setTimeout(() => {
      if (askPending() && q === lastQuestion) bus.emit({ type: 'voice.started', handsFree: true })
    }, speakMs(q))
  }
}
let lastQuestion = ''

function deps(
  env: TaskEnv,
  spawn: boolean,
  skills: SkillToolSet,
  guard?: ToolGuard,
  trace?: RunTrace
): RunnerDeps {
  const handlers: RunnerDeps['handlers'] = {
    ...createHandlers(env),
    ...skills.handlers,
    memory_search: async (input) => {
      const q = memorySearchInput.safeParse(input)
      if (!q.success) return { content: [{ type: 'text', text: 'Invalid input.' }], isError: true }
      return { content: [{ type: 'text', text: observed('memory', memorySearchFor(q.data)) }] }
    },
    ...(spawn ? { spawn_task: foregroundSpawnHandler(env.taskId) } : {})
  }
  // A skill's permissions (11 T04) in front of every call; successful UI calls are traced for
  // "save that as a skill" (11 T09).
  for (const [name, h] of Object.entries(handlers)) {
    if (!h) continue
    handlers[name] = async (input, ctx) => {
      const refused = guard ? await guard(name, input, ctx.signal) : null
      if (refused) return refused
      const note = trace?.before(name, input)
      const out = await h(input, ctx)
      if (note && !out.isError) trace?.after(note)
      return out
    }
  }
  return {
    model,
    handlers,
    publish: (task) => {
      if (task.question?.text) lastQuestion = task.question.text
      showOnBar(task)
      transcripts().foregroundTask(task)
    },
    speak: say,
    countdown: (ms, signal) =>
      new Promise((resolve) => {
        const finish = (r: 'go' | 'cancel' | 'elapsed'): void => {
          clearTimeout(t)
          countdownAnswer = null
          signal.removeEventListener('abort', onAbort)
          resolve(r)
        }
        const onAbort = (): void => finish('cancel')
        const t = setTimeout(() => finish('elapsed'), ms)
        countdownAnswer = finish
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    askContinue: (reason) =>
      assistant.requestConfirm({
        summary: `This task reached its limit of ${reason}. Keep going?`,
        risk: 'medium'
      }),
    costOf: (m, u) => usageCost(m, u).total,
    now: () => Date.now(),
    inputLane: inputLane(),
    newId: () => env.taskId,
    log: (tag, msg) => log(tag as LogTag, msg),
    observe: (e) => transcripts().rec(env.taskId).run(e),
    between: async () => transcripts().drain(env.taskId)
  }
}

function toResponse(r: RunResult): ModelResponse {
  if (r.status === 'paused')
    return {
      mode: 'answer',
      text: 'Paused. Answer the question or say "resume the task" within ten minutes.'
    }
  const body = r.report
    ? `${r.summary}

${r.report}`
    : r.summary
  const markdown = r.needsUserAction ? `${body}\n\n**Your turn:** ${r.needsUserAction}` : body
  const spoken = r.needsUserAction
    ? `${r.summary} ${r.needsUserAction}.`.replace(/\.\.$/, '.')
    : r.summary
  return { mode: 'answer', text: markdown, markdown, spoken }
}

async function run(
  prompt: string,
  env: TaskEnv,
  context: TaskContext,
  signal: AbortSignal,
  extra: {
    skipPlan?: boolean
    resume?: SavedRun
    noSpawn?: boolean
    /** A skill run: its permission check, its tool list and its connectors. */
    envelope?: SkillEnvelope
    onResult?: (r: RunResult) => void
  }
): Promise<ModelResponse> {
  const { noSpawn, envelope, onResult, ...more } = extra
  if (running) throw new Error('An agent task is already running.')
  const ac = new AbortController()
  const onOuter = (): void => ac.abort(signal.reason)
  if (signal.aborted) ac.abort(signal.reason)
  signal.addEventListener('abort', onOuter, { once: true })
  running = { taskId: env.taskId, abort: () => ac.abort() }
  lastStatus = ''
  // Skills (11 T02): the L1 list after the agent prompt, use_skill / read_skill_file as tools.
  const skills = skillToolSet()
  // Connectors (08 T18): the enabled MCP servers' tools; a skill only gets its own servers.
  const mcp = await mcpToolSet(env).catch(() => ({
    defs: [] as ToolDef[],
    handlers: {} as Record<string, ToolHandler>
  }))
  const mcpDefs = connectorDefsFor(mcp.defs, envelope)
  const trace = traceRecorder()
  if (!more.resume) transcripts().foregroundStart(env.taskId, prompt)
  try {
    const r = await withCancelArmed(() =>
      runAgent(
        {
          prompt,
          context,
          tools:
            envelope?.tools ??
            (context.files?.length ? [...FOREGROUND_TOOLS, 'read_file'] : FOREGROUND_TOOLS),
          // Helper tasks in the background (T28): parallel research fan-out.
          extraTools: [
            MEMORY_SEARCH_TOOL,
            ...skills.defs,
            ...mcpDefs,
            ...(noSpawn ? [] : [BG_TOOLS.spawn_task])
          ].filter((d) => !envelope || envelope.offers(d.name)),
          parallelTools: ['spawn_task'],
          ...(skills.index ? { systemExtra: skills.index } : {}),
          cancelWindowMs: loadConfig().agent.cancelWindowMs,
          signal: ac.signal,
          speakSummary: false,
          ...more
        },
        deps(
          env,
          !noSpawn,
          { ...skills, handlers: { ...skills.handlers, ...mcp.handlers } },
          envelope?.guard,
          trace
        )
      )
    )
    onResult?.(r)
    transcripts().foregroundEnd(env.taskId, r)
    if (r.status === 'done' && trace.steps.length)
      rememberAgentRun({ prompt, summary: r.summary, at: Date.now(), steps: trace.steps })
    paused =
      r.status === 'paused' && r.saved
        ? {
            saved: r.saved,
            env,
            context,
            until: Date.now() + PAUSE_KEEP_MS,
            ...(envelope ? { envelope } : {}),
            ...(noSpawn ? { noSpawn } : {})
          }
        : null
    log(
      'done',
      `agent task ${r.status}: ${r.task.counters.actions} actions, ${r.task.counters.modelCalls} model calls`
    )
    bus.emit({ type: 'agent.task', task: r.status === 'paused' ? r.task : null })
    return toResponse(r)
  } catch (e) {
    transcripts().foregroundEnd(env.taskId, {
      error: (e as Error).message,
      cancelled: ac.signal.aborted
    })
    bus.emit({ type: 'agent.task', task: null })
    throw e
  } finally {
    signal.removeEventListener('abort', onOuter)
    running = null
    countdownAnswer = null
  }
}

/** `prompt`: the user's own words (the policy's userText); `observed`: text that is not theirs. */
function newEnv(taskId: string, prompt: string, observed = ''): TaskEnv {
  return {
    taskId,
    prompt,
    state: newTaskState(),
    fields: { typed: new Map() },
    observedText: observed,
    ask: askIo
  }
}

let seq = 0

/** Runs a multi-step request as an agent task; the reply is the spoken summary. */
export function runAgentTask(
  prompt: string,
  ctx: QueryContext,
  signal: AbortSignal,
  opts: {
    skipPlan?: boolean
    noSpawn?: boolean
    skill?: string
    skillArgs?: { name: string; value: string }[]
    /**
     * Started by a background task (request_foreground): the user's own words for the policy,
     * since `prompt` was written by the background model ...
     */
    userText?: string
    /** ... which is therefore observed text (the injection check reads it). */
    observedText?: string
    /** ... and the permission envelopes of the skills that task runs under. */
    underSkills?: readonly string[]
  } = {}
): Promise<ModelResponse> {
  paused = null
  const taskId = `t_${Date.now().toString(36)}${(seq++).toString(36)}`
  const { skill, skillArgs, userText, observedText, underSkills, ...extra } = opts
  const env = newEnv(taskId, userText ?? prompt, observedText)
  const context = taskContext(ctx, prompt)
  if (underSkills?.length) {
    const list = underSkills.map((n) => enabledSkill(n))
    if (list.some((x) => !x)) throw new Error('A skill this task runs under is off or gone.')
    const envelope = joinEnvelopes(
      list.map((x) => skillEnvelope(x as LoadedSkill, taskId, skillHost))
    )
    return run(prompt, env, context, signal, { ...extra, noSpawn: true, envelope })
  }
  // A skill named by its trigger phrase: its instructions are the task's guide.
  const loaded = skill ? preloadSkill(skill, skillArgs) : null
  if (loaded) context.skill = loaded
  const s = skill ? enabledSkill(skill) : null
  if (s) return runSkill(s, prompt, env, context, signal, skillArgs, extra)
  return run(prompt, env, context, signal, extra)
}

const skillHost: SkillHost = { speak: say, publish: showOnBar, ask: askIo }

const RUN_STATUS: Record<RunResult['status'], SkillRunRecord['status']> = {
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  paused: 'paused'
}

const sayable = (name: string): string => name.replace(/-/g, ' ')

/**
 * A foreground skill run (11 T04): its steps.json without the model when it has one (verified
 * step by step), the model with the skill's instructions after drift or without steps. The
 * skill's permissions guard both; the run is audited and kept in the skill's history.
 */
async function runSkill(
  s: LoadedSkill,
  prompt: string,
  env: TaskEnv,
  context: TaskContext,
  signal: AbortSignal,
  args: { name: string; value: string }[] | undefined,
  extra: { skipPlan?: boolean; noSpawn?: boolean }
): Promise<ModelResponse> {
  const name = s.manifest.name
  const startedAt = Date.now()
  let how: SkillRunRecord['how'] = 'agent'
  let actions = 0
  const end = (status: SkillRunRecord['status'], summary: string): void =>
    finishSkillRun(env, name, { how, status, summary, actions }, startedAt)
  try {
    let task = prompt
    if (s.hasSteps) {
      const steps = await runExclusive(env.taskId, signal, (sig) =>
        runStepsForeground(s, env, args, skillHost, sig)
      )
      if (steps.kind === 'outcome') {
        how = 'steps'
        const o = steps.outcome
        actions = o.actions
        if (o.status !== 'drift') {
          const why = o.status === 'denied' ? o.reason.replace(/^E_DENIED: /, '') : ''
          const text =
            o.status === 'done'
              ? `Done: ${sayable(name)}, ${o.ran} ${o.ran === 1 ? 'step' : 'steps'}.`
              : `I stopped ${sayable(name)} at step ${o.at + 1}: ${why.replace(/ Do not retry.*$/, '')}`
          end(o.status, o.status === 'done' ? `${o.ran} steps without the model` : why)
          bus.emit({ type: 'agent.task', task: null })
          return { mode: 'answer', text, spoken: text }
        }
        log('plan', `skill ${name}: drift at step ${o.at + 1} (${o.reason}); the model goes on`)
        how = 'steps+agent'
        task = afterDrift(prompt, steps)
      }
    }
    let result: RunResult | null = null
    const response = await run(task, env, context, signal, {
      ...extra,
      noSpawn: true,
      ...(how === 'steps+agent' ? { skipPlan: true } : {}),
      envelope: skillEnvelope(s, env.taskId, skillHost),
      onResult: (r) => (result = r)
    })
    const r = result as RunResult | null
    if (r) {
      actions += r.task.counters.actions
      end(RUN_STATUS[r.status], r.summary)
    }
    return response
  } catch (e) {
    const cancelled =
      signal.aborted || (e as Error).name === 'AbortError' || e instanceof CancelledError
    end(cancelled ? 'cancelled' : 'failed', cancelled ? 'Stopped.' : (e as Error).message)
    throw e
  }
}

/** Runs `fn` as the one foreground task ("stop" and Escape abort it). */
async function runExclusive<T>(
  taskId: string,
  signal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (running) throw new Error('An agent task is already running.')
  const ac = new AbortController()
  const onOuter = (): void => ac.abort(signal.reason)
  if (signal.aborted) ac.abort(signal.reason)
  signal.addEventListener('abort', onOuter, { once: true })
  running = { taskId, abort: () => ac.abort() }
  lastStatus = ''
  try {
    return await withCancelArmed(() => fn(ac.signal))
  } catch (e) {
    bus.emit({ type: 'agent.task', task: null })
    throw e
  } finally {
    signal.removeEventListener('abort', onOuter)
    running = null
  }
}

/** "resume the task": continues the paused task by asking its question again. */
export function resumeAgentTask(signal: AbortSignal): Promise<ModelResponse> | null {
  if (!hasPausedTask()) return null
  const p = paused!
  paused = null
  // A skill run resumes inside the same envelope (guard, tools, connectors).
  return run(p.saved.task.prompt, p.env, p.context, signal, {
    resume: p.saved,
    ...(p.envelope ? { envelope: p.envelope } : {}),
    ...(p.noSpawn ? { noSpawn: true } : {})
  })
}
