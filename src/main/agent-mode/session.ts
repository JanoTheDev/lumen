// Foreground agent mode: one task at a time, started by the query pipeline for multi-step
// requests. Wires the runner to the providers (planning role for the plan, main role for the
// tool loop), the assistant bar (state, countdown, cap confirm), speech and the voice
// commands that only apply while a task runs ("go", "stop", "wait", answers, "resume the task").
import type { AgentTask } from '@shared/events'
import type { ModelResponse } from '@shared/types'
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
import { PLAN_SYSTEM, normalizePlan, planSchema, planTurn, type TaskContext } from './prompts'
import {
  runAgent,
  type RunnerDeps,
  type RunnerModel,
  type RunResult,
  type SavedRun
} from './runner'
import { FOREGROUND_TOOLS } from './tools'

const PAUSE_KEEP_MS = 10 * 60_000
const TURN_MAX_TOKENS = 2048
const PLAN_MAX_TOKENS = 600

let running: { taskId: string; abort: () => void } | null = null
let countdownAnswer: ((r: 'go' | 'cancel') => void) | null = null
let paused: { saved: SavedRun; env: TaskEnv; context: TaskContext; until: number } | null = null

/** A task is running (or counting down / asking). */
export function agentRunning(): boolean {
  return !!running
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
  const skill = ctx.skill
    ? { name: ctx.skill.name, text: skillContext(ctx.skill, prompt) }
    : undefined
  return {
    window: ctx.activeWindow,
    app: ctx.foreground.process,
    ...(skill?.text ? { skill } : {}),
    language: replyLanguageLine(loadConfig().voice.language),
    now: new Date()
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

function deps(env: TaskEnv): RunnerDeps {
  return {
    model,
    handlers: createHandlers(env),
    publish: (task) => {
      if (task.question?.text) lastQuestion = task.question.text
      showOnBar(task)
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
    newId: () => env.taskId,
    log: (tag, msg) => log(tag as LogTag, msg)
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
  extra: { skipPlan?: boolean; resume?: SavedRun }
): Promise<ModelResponse> {
  if (running) throw new Error('An agent task is already running.')
  const ac = new AbortController()
  const onOuter = (): void => ac.abort(signal.reason)
  if (signal.aborted) ac.abort(signal.reason)
  signal.addEventListener('abort', onOuter, { once: true })
  running = { taskId: env.taskId, abort: () => ac.abort() }
  lastStatus = ''
  try {
    const r = await withCancelArmed(() =>
      runAgent(
        {
          prompt,
          context,
          tools: FOREGROUND_TOOLS,
          cancelWindowMs: loadConfig().agent.cancelWindowMs,
          signal: ac.signal,
          speakSummary: false,
          ...extra
        },
        deps(env)
      )
    )
    paused =
      r.status === 'paused' && r.saved
        ? { saved: r.saved, env, context, until: Date.now() + PAUSE_KEEP_MS }
        : null
    log(
      'done',
      `agent task ${r.status}: ${r.task.counters.actions} actions, ${r.task.counters.modelCalls} model calls`
    )
    bus.emit({ type: 'agent.task', task: r.status === 'paused' ? r.task : null })
    return toResponse(r)
  } catch (e) {
    bus.emit({ type: 'agent.task', task: null })
    throw e
  } finally {
    signal.removeEventListener('abort', onOuter)
    running = null
    countdownAnswer = null
  }
}

function newEnv(taskId: string, prompt: string): TaskEnv {
  return {
    taskId,
    prompt,
    state: newTaskState(),
    fields: { typed: new Map() },
    observedText: '',
    ask: askIo
  }
}

let seq = 0

/** Runs a multi-step request as an agent task; the reply is the spoken summary. */
export function runAgentTask(
  prompt: string,
  ctx: QueryContext,
  signal: AbortSignal,
  opts: { skipPlan?: boolean } = {}
): Promise<ModelResponse> {
  paused = null
  const taskId = `t_${Date.now().toString(36)}${(seq++).toString(36)}`
  return run(prompt, newEnv(taskId, prompt), taskContext(ctx, prompt), signal, opts)
}

/** "resume the task": continues the paused task by asking its question again. */
export function resumeAgentTask(signal: AbortSignal): Promise<ModelResponse> | null {
  if (!hasPausedTask()) return null
  const p = paused!
  paused = null
  return run(p.saved.task.prompt, p.env, p.context, signal, { resume: p.saved })
}
