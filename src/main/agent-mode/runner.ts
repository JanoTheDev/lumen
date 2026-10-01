// The agent loop (agent-loop.md, T07): plan → announce → countdown → tool-use loop → finish.
// Everything outside the loop itself is injected (model, tool handlers, speech, countdown, the
// input lane), so the same runner serves foreground agent mode and, later, background agents
// with a different tool set and no input lane.
//
// Cancel: one AbortController per task, linked to the caller's signal. Every await races the
// signal, so an abort ends the run within one tick of the current await even when the awaited
// work (a provider call, a wait) ignores the signal. Nothing is published or spoken after an
// abort except "Stopped."; the abort reason is rethrown.
import type { AgentTask } from '@shared/events'
import type {
  AgentMessage,
  SystemBlock,
  ToolCall,
  ToolContent,
  ToolDef,
  ToolResultBlock,
  ToolTurnResult,
  Usage
} from '../ai/providers/types'
import { CancelledError } from '../query/cancel'
import { AGENT_SYSTEM, taskTurn, type AgentPlan, type TaskContext } from './prompts'
import { closeSteps, currentStep, enterStep, newTask, setStep, withPlan } from './task'
import { INPUT_TOOLS, toolSet, type ToolName } from './tools'

export interface Caps {
  maxActions: number
  maxWallMs: number
  maxModelCalls: number
  maxCostUsd: number
}

/** safety-policy §7. */
export const DEFAULT_CAPS: Caps = {
  maxActions: 25,
  maxWallMs: 300_000,
  maxModelCalls: 30,
  maxCostUsd: 0.5
}

export interface ToolOutcome {
  content: ToolContent[]
  isError?: boolean
  /** Real input actions run (counted against maxActions). */
  actions?: number
  /** The check after the call failed (T11); counts toward the step's single retry. */
  verifyFailed?: boolean
  /** ask_user got no answer in time: the task pauses (resumable). */
  noAnswer?: boolean
  /** Short line for the step's detail list. */
  label?: string
}

export interface ToolCtx {
  task(): AgentTask
  update(patch: Partial<AgentTask>): void
  signal: AbortSignal
  /** Plan step the call belongs to. */
  step?: number
  /** This step's check already failed once: this is its one retry. */
  retry: boolean
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolOutcome>

/** One holder of the real mouse and keyboard at a time (08 T25 implements it). */
export interface InputLane {
  acquire(owner: string, signal: AbortSignal): Promise<() => void>
}

export interface ModelUse {
  model: string
  usage: Usage
}

export interface RunnerModel {
  plan(
    prompt: string,
    ctx: TaskContext,
    signal: AbortSignal
  ): Promise<{ plan: AgentPlan | null } & Partial<ModelUse>>
  turn(
    req: { system: SystemBlock[]; tools: ToolDef[]; messages: AgentMessage[] },
    signal: AbortSignal
  ): Promise<ToolTurnResult>
}

export interface RunnerDeps {
  model: RunnerModel
  handlers: Partial<Record<string, ToolHandler>>
  /** New state for the bar (also after every step change). */
  publish(task: AgentTask): void
  speak(text: string): void
  /** The cancel window: 'go' skips it, 'cancel' stops the task before any action. */
  countdown(ms: number, signal: AbortSignal): Promise<'go' | 'cancel' | 'elapsed'>
  /** A cap was reached: true = keep going (the caps grow by their defaults). */
  askContinue(reason: string, signal: AbortSignal): Promise<boolean>
  costOf(model: string, usage: Usage): number
  now(): number
  inputLane?: InputLane
  newId?(): string
  log?(tag: string, msg: string): void
}

/** What a paused run needs to continue ("resume the task"). */
export interface SavedRun {
  task: AgentTask
  messages: AgentMessage[]
  /** Calls of the last assistant turn not answered yet (the unanswered ask_user first). */
  pending: ToolCall[]
  /** Results already produced for that turn. */
  results: ToolResultBlock[]
  caps: Caps
  verifyFails: Record<number, number>
}

export interface RunOptions {
  prompt: string
  context: TaskContext
  tools: readonly ToolName[]
  /** Tools outside the agent-mode table (background set, spawn_task, skills). */
  extraTools?: readonly ToolDef[]
  /** Consecutive calls of these tools in one turn run at the same time (spawn_task fan-out). */
  parallelTools?: readonly string[]
  cancelWindowMs: number
  system?: string
  /** A second cacheable system block after the prompt (the skills list, L1). */
  systemExtra?: string
  /** First user turn instead of the agent-mode one (background tasks: no screen). */
  firstTurn?: string
  /** No plan and no countdown (a continuation the user already saw start). */
  skipPlan?: boolean
  caps?: Partial<Caps>
  /** How much "keep going" at a cap adds (default DEFAULT_CAPS). */
  capStep?: Partial<Caps>
  signal?: AbortSignal
  resume?: SavedRun
  /** Input-lane owner name. */
  owner?: string
  /** Speak the finish summary (false when the caller shows and speaks it as the answer). */
  speakSummary?: boolean
}

export type RunStatus = 'done' | 'failed' | 'stopped' | 'paused'

export interface RunResult {
  status: RunStatus
  summary: string
  needsUserAction?: string
  /** finish report: markdown findings with sources (research), shown not spoken. */
  report?: string
  task: AgentTask
  saved?: SavedRun
}

/** Rejects as soon as `signal` aborts, whatever `p` does. */
export function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CancelledError()
}

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]

function describeCall(c: ToolCall): string {
  const i = c.input
  switch (c.name) {
    case 'act': {
      const t = i.target as { ref?: string } | undefined
      return `${String(i.op ?? 'act')}${t?.ref ? ` "${t.ref}"` : ''}`
    }
    case 'keys':
      return `press ${String(i.combo ?? '')}`
    case 'navigate':
      return `open ${String(i.url ?? '')}`
    case 'launch_app':
      return `start ${String(i.app ?? '')}`
    case 'wait_for':
      return `wait for ${String((i.condition as { value?: string } | undefined)?.value ?? '')}`
    default:
      return c.name
  }
}

let seq = 0
const defaultId = (): string => `t_${Date.now().toString(36)}${(seq++).toString(36)}`

const SYSTEM_BLOCKS = (system: string, extra?: string): SystemBlock[] => [
  { text: system, cacheable: true },
  ...(extra ? [{ text: extra, cacheable: true }] : [])
]

export async function runAgent(opts: RunOptions, deps: RunnerDeps): Promise<RunResult> {
  const controller = new AbortController()
  const outer = opts.signal
  const onOuter = (): void => controller.abort(outer?.reason)
  if (outer?.aborted) controller.abort(outer.reason)
  else outer?.addEventListener('abort', onOuter, { once: true })
  const signal = controller.signal
  const log = deps.log ?? (() => {})

  const caps: Caps = { ...DEFAULT_CAPS, ...opts.caps, ...opts.resume?.caps }
  const capStep: Caps = { ...DEFAULT_CAPS, ...opts.capStep }
  let task: AgentTask =
    opts.resume?.task ?? newTask(deps.newId?.() ?? defaultId(), opts.prompt, deps.now())
  const publish = (): void => {
    if (!signal.aborted) deps.publish(task)
  }
  const update = (patch: Partial<AgentTask>): void => {
    task = { ...task, ...patch }
    publish()
  }
  const addCost = (use: Partial<ModelUse>): void => {
    task.counters = {
      ...task.counters,
      modelCalls: task.counters.modelCalls + 1,
      costUsd:
        task.counters.costUsd + (use.model && use.usage ? deps.costOf(use.model, use.usage) : 0)
    }
  }

  const extra = opts.extraTools ?? []
  const tools = [...toolSet(opts.tools), ...extra]
  const allowed = new Set<string>([...opts.tools, ...extra.map((t) => t.name)])
  const parallel = new Set(opts.parallelTools ?? [])
  const usesInput = opts.tools.some((t) => INPUT_TOOLS.includes(t))
  const verifyFails: Record<number, number> = { ...opts.resume?.verifyFails }
  let release: (() => void) | null = null

  try {
    let messages: AgentMessage[]
    if (opts.resume) {
      messages = opts.resume.messages
      update({ phase: 'running', question: undefined })
    } else {
      // 1. PLAN
      let plan: AgentPlan | null = null
      if (!opts.skipPlan) {
        publish()
        const res = await raced(deps.model.plan(opts.prompt, opts.context, signal), signal)
        addCost(res)
        plan = res.plan
        if (plan) task = withPlan(task, plan.summary, plan.steps)
        log(
          'plan',
          plan ? `agent plan: ${plan.steps.join(' | ')}` : 'agent plan: none, going ahead'
        )
      }
      // 2. ANNOUNCE + countdown (the cancel window)
      if (!opts.skipPlan && opts.cancelWindowMs > 0) {
        update({ phase: 'countdown', countdownMs: opts.cancelWindowMs })
        const seconds = Math.max(1, Math.round(opts.cancelWindowMs / 1000))
        deps.speak(`I'll ${task.summary}. Starting in ${seconds}.`)
        const r = await raced(deps.countdown(opts.cancelWindowMs, signal), signal)
        if (r === 'cancel') {
          controller.abort(new CancelledError())
          throw abortReason(signal)
        }
      }
      update({ phase: 'running', countdownMs: undefined })
      messages = [
        {
          role: 'user',
          content: text(opts.firstTurn ?? taskTurn(opts.prompt, opts.context, plan?.steps ?? null))
        }
      ]
    }

    if (usesInput && deps.inputLane)
      release = await raced(deps.inputLane.acquire(opts.owner ?? task.id, signal), signal)

    // 3. LOOP
    let pending: ToolCall[] = opts.resume?.pending ?? []
    let results: ToolResultBlock[] = opts.resume?.results ?? []
    for (;;) {
      if (!pending.length) {
        const capHit = capReached(task, caps, deps.now())
        if (capHit && !(await continuePast(capHit)))
          return stop(`I stopped at the limit: ${capHit}.`)
        const turn = await raced(
          deps.model.turn(
            {
              system: SYSTEM_BLOCKS(opts.system ?? AGENT_SYSTEM, opts.systemExtra),
              tools,
              messages
            },
            signal
          ),
          signal
        )
        addCost(turn)
        publish()
        messages = [...messages, turn.message]
        pending = [...turn.message.calls]
        results = []
        if (!pending.length) {
          // Ended without finish: the reply text is the summary.
          return finish(turn.message.text.trim() || 'Done.', undefined)
        }
      }

      while (pending.length) {
        const call = pending[0]
        if (call.name === 'finish') {
          const summary = String(call.input.summary ?? '').trim() || 'Done.'
          const needs = call.input.needsUserAction ? String(call.input.needsUserAction) : undefined
          const report = call.input.report ? String(call.input.report) : undefined
          return finish(summary, needs, report)
        }
        if (INPUT_TOOLS.includes(call.name as ToolName)) {
          const capHit = capReached(task, caps, deps.now())
          if (capHit && !(await continuePast(capHit)))
            return stop(`I stopped at the limit: ${capHit}.`)
        }
        if (parallel.has(call.name)) {
          let n = 1
          while (n < pending.length && pending[n].name === call.name) n++
          const batch = pending.slice(0, n)
          const outcomes = await Promise.all(batch.map((c) => runCall(c)))
          batch.forEach((c, i) =>
            results.push({
              type: 'tool_result',
              id: c.id,
              content: outcomes[i].content,
              ...(outcomes[i].isError ? { isError: true } : {})
            })
          )
          pending = pending.slice(n)
          continue
        }
        const outcome = await runCall(call)
        if (outcome.noAnswer) {
          // ask_user timed out: keep the run (this call first) for "resume the task".
          update({ phase: 'paused' })
          const saved: SavedRun = {
            task,
            messages,
            pending: [...pending],
            results: [...results],
            caps,
            verifyFails
          }
          return { status: 'paused', summary: 'Paused until you answer.', task, saved }
        }
        results.push({
          type: 'tool_result',
          id: call.id,
          content: outcome.content,
          ...(outcome.isError ? { isError: true } : {})
        })
        pending = pending.slice(1)
      }
      messages = [...messages, { role: 'user', content: results }]
    }
  } catch (e) {
    if (signal.aborted) {
      const at = currentStep(task)
      log('skip', `agent task aborted${at ? ` at step ${at}` : ''}`)
      task = { ...closeSteps(task, false), phase: 'aborted' }
      deps.publish(task)
      deps.speak('Stopped.')
      throw abortReason(signal)
    }
    task = { ...closeSteps(task, false), phase: 'failed' }
    deps.publish(task)
    throw e
  } finally {
    release?.()
    outer?.removeEventListener('abort', onOuter)
  }

  async function continuePast(reason: string): Promise<boolean> {
    update({ phase: 'confirm' })
    const yes = await raced(deps.askContinue(reason, signal), signal)
    if (!yes) return false
    caps.maxActions += capStep.maxActions
    caps.maxModelCalls += capStep.maxModelCalls
    caps.maxCostUsd += capStep.maxCostUsd
    caps.maxWallMs += capStep.maxWallMs
    update({ phase: 'running' })
    return true
  }

  async function runCall(call: ToolCall): Promise<ToolOutcome> {
    const handler = deps.handlers[call.name]
    if (!allowed.has(call.name) || !handler)
      return { content: text(`Unknown tool "${call.name}".`), isError: true }
    const explicit = typeof call.input.step === 'number' ? call.input.step : undefined
    const step = explicit ?? currentStep(task)
    const fails = step !== undefined ? (verifyFails[step] ?? 0) : 0
    if (fails >= 2)
      return {
        content: text(
          `Step ${step} already failed its check twice. Do not retry it; call finish and say what went wrong, or ask the user.`
        ),
        isError: true
      }
    if (explicit !== undefined || INPUT_TOOLS.includes(call.name as ToolName))
      task = enterStep(task, step, describeCall(call))
    publish()
    let outcome: ToolOutcome
    try {
      outcome = await raced(
        handler(call.input, { task: () => task, update, signal, step, retry: fails === 1 }),
        signal
      )
    } catch (e) {
      if (signal.aborted) throw e
      outcome = { content: text(`Error: ${(e as Error).message}`), isError: true }
    }
    if (outcome.actions)
      task.counters = { ...task.counters, actions: task.counters.actions + outcome.actions }
    if (outcome.verifyFailed && step !== undefined) {
      verifyFails[step] = fails + 1
      if (fails + 1 >= 2) {
        task = setStep(task, step, 'failed')
        outcome = {
          ...outcome,
          isError: true,
          content: [
            ...outcome.content,
            ...text('This was the retry; do not try this step again. Call finish or ask the user.')
          ]
        }
      }
    }
    if (outcome.label && step !== undefined) task = enterStep(task, step, outcome.label)
    if (task.phase !== 'running') task = { ...task, phase: 'running', question: undefined }
    publish()
    return outcome
  }

  function finish(summary: string, needsUserAction?: string, report?: string): RunResult {
    task = { ...closeSteps(task, true), phase: 'done', needsUserAction }
    publish()
    if (opts.speakSummary !== false)
      deps.speak(needsUserAction ? `${summary} ${needsUserAction}.`.replace(/\.\.$/, '.') : summary)
    return { status: 'done', summary, needsUserAction, report, task }
  }

  function stop(summary: string): RunResult {
    task = { ...closeSteps(task, false), phase: 'failed' }
    publish()
    deps.speak(summary)
    return { status: 'stopped', summary, task }
  }
}

/** The first cap the task has reached, in words; null when none. */
export function capReached(task: AgentTask, caps: Caps, now: number): string | null {
  const c = task.counters
  if (c.actions >= caps.maxActions) return `${caps.maxActions} actions`
  if (c.modelCalls >= caps.maxModelCalls) return `${caps.maxModelCalls} model calls`
  if (c.costUsd >= caps.maxCostUsd) return `$${caps.maxCostUsd.toFixed(2)} of model use`
  if (now - c.startedAt >= caps.maxWallMs) return `${Math.round(caps.maxWallMs / 60000)} minutes`
  return null
}
