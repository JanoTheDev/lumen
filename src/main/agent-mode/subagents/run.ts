// Sub-agent runs (08 T49): each job of a run_subagents call runs on the shared agent-loop
// runner in background mode (no plan, no countdown, no input lane, nothing spoken) with its
// role's prompt and tools, in the pool. The tools are the parent's own handlers, already behind
// the parent's guards (skill envelope, pre-approval, granted folders, network, the policy
// gate's userText / observed text), so a job can do nothing its parent could not.
//
// Budget: every job's model and tool cost counts toward the parent's cost cap; a job stops
// before its next turn once the parent's remaining money is spent. Cancel: the parent's signal
// ends every job (and takes waiting ones out of the pool). Pause: jobs wait between turns.
import { currentUsageScope, runInUsageScope, withUsageScope } from '../../usage/scope'
import type { SubJob } from '@shared/task-chat'
import type {
  AgentMessage,
  SystemBlock,
  ToolContent,
  ToolDef,
  ToolTurnResult,
  Usage
} from '../../ai/providers/types'
import { redactForModel } from '../../actions/redact'
import { readUrls } from '../../cards/research'
import { observed, stripTags } from '../prompts'
import {
  raced,
  runAgent,
  type RunnerDeps,
  type ToolCtx,
  type ToolHandler,
  type ToolOutcome
} from '../runner'
import { toolLabel } from '../transcript'
import { jobCaps, isRole, RESULT_MAX, ROLES, roleTools, type SubagentRole } from './roles'
import type { SubagentPool } from './pool'
import { MAX_JOBS, runSubagentsInput } from './tool'

/** What a parent hands its sub-agents. */
export interface SubagentEnv {
  pool: SubagentPool
  /** The parent's offered tools with their (guarded) handlers; roles pick from these. */
  tools(): Promise<{ defs: ToolDef[]; handlers: Record<string, ToolHandler> }>
  /** One model turn on the sub-agent model (fast or main, or the parent skill's). */
  turn(
    req: { system: SystemBlock[]; tools: ToolDef[]; messages: AgentMessage[] },
    signal: AbortSignal
  ): Promise<ToolTurnResult>
  costOf(model: string, usage: Usage): number
  now(): number
  /** Per-job cost cap (Settings). */
  costCapUsd: number
  /** Waits while the parent is paused. */
  hold?(signal: AbortSignal): Promise<void>
  /** Jobs of this parent running now (the Home Tasks row: "N helpers working"). */
  onActive?(n: number): void
  log?(tag: string, msg: string): void
}

export interface JobResult {
  role: SubagentRole
  task: string
  status: 'done' | 'failed' | 'stopped'
  /** ≤ RESULT_MAX characters, redacted. */
  text: string
  sources: string[]
  costUsd: number
}

/** The parent's money ran out: the job stops before its next turn. */
class BudgetSpent extends Error {
  constructor() {
    super("the task's budget ran out")
  }
}

/** The job ran past its wall-clock cap (also while a tool or a model call was still waiting). */
class JobTimeLimit extends Error {
  constructor(ms: number) {
    super(`it ran past its ${Math.max(1, Math.round(ms / 60_000))}-minute limit`)
  }
}

/**
 * Money shared by the jobs of one call: the parent's remaining budget. A model turn reserves
 * its expected cost first (the dearest turn seen so far, before any: `firstGuess`), so
 * parallel jobs cannot all start a turn on the last cent: when the money left does not cover
 * the reservations, a turn waits for the running ones; once it cannot cover one more turn
 * (and one has been measured), the job stops.
 */
export class SharedBudget {
  private spent = 0
  private reserved = 0
  private inFlight = 0
  private estimate: number | null = null
  private waiters = new Set<() => void>()
  constructor(
    private readonly limit: number,
    private readonly firstGuess = 0
  ) {}
  spend(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd
  }
  get left(): number {
    return this.limit - this.spent
  }
  get total(): number {
    return this.spent
  }

  /** Waits for room for one turn; resolves with the call that ends it (its real cost). */
  async reserve(signal: AbortSignal): Promise<(costUsd: number) => void> {
    if (!Number.isFinite(this.limit)) return (usd) => this.spend(usd)
    for (;;) {
      if (signal.aborted) throw signal.reason
      if (this.left <= 0) throw new BudgetSpent()
      const measured = this.estimate
      const need = measured ?? this.firstGuess
      const free = this.left - this.reserved
      if (free >= need || (measured === null && !this.inFlight)) {
        const held = need
        this.reserved += held
        this.inFlight++
        let open = true
        return (usd) => {
          if (!open) return
          open = false
          this.reserved -= held
          this.inFlight--
          this.spend(usd)
          if (Number.isFinite(usd) && usd > 0) this.estimate = Math.max(this.estimate ?? 0, usd)
          for (const w of [...this.waiters]) w()
        }
      }
      if (!this.inFlight) throw new BudgetSpent()
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiters.delete(wake)
          signal.removeEventListener('abort', wake)
          resolve()
        }
        this.waiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
  }
}

const MAX_SOURCES = 8
const TASK_SHOWN = 200
const NO_ACTION_CAP = 1_000_000

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const textOf = (c: readonly ToolContent[]): string =>
  c.map((x) => (x.type === 'text' ? x.text : '')).join('\n')

function clip(t: string, max: number): string {
  const s = t.trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The first user turn of a job. */
export function jobTurn(task: string, now: Date): string {
  const when = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `<context>\ndate: ${when}\n</context>\n<job>${task}</job>`
}

const FENCE_TAGS = ['observed', 'sources'] as const

/** A fetched URL as the parent sees it: no query, fragment or login (they can hold tokens). */
function sourceShown(raw: string): string | null {
  try {
    const u = new URL(raw)
    u.search = ''
    u.hash = ''
    u.username = ''
    u.password = ''
    return redactForModel(u.toString())
  } catch {
    return null
  }
}

/** A job's result as the parent model reads it: fenced, redacted, sources listed by Lumen. */
export function fenceResult(r: JobResult, i: number): string {
  // The model-written text may not fake the sources list or close the fence; only the URLs
  // Lumen saw fetched go in <sources>. Both tags at once: removing one may not form the other.
  const body = stripTags(r.text, FENCE_TAGS)
  const lines = [
    // The parent model wrote the task line: it may not list sources either.
    `job ${i + 1} (${r.role}): ${clip(stripTags(r.task, FENCE_TAGS), TASK_SHOWN)}`,
    `status: ${r.status}`,
    body
  ]
  const sources = r.sources.map(sourceShown).filter((u): u is string => !!u)
  if (sources.length) lines.push(`<sources>\n${sources.join('\n')}\n</sources>`)
  return observed(`subagent:${r.role}`, lines.join('\n'))
}

/** Runs one job; throws only when the parent was cancelled. */
export async function runJob(
  role: SubagentRole,
  task: string,
  offered: { defs: ToolDef[]; handlers: Record<string, ToolHandler> },
  env: SubagentEnv,
  budget: SharedBudget,
  parent: Pick<ToolCtx, 'task'>,
  signal: AbortSignal,
  onStep?: (label: string, costUsd: number) => void
): Promise<JobResult> {
  const spec = ROLES[role]
  const defs = roleTools(role, offered.defs)
  const sources: string[] = []
  let cost = 0
  /** This job's share only (the shared budget already counted it). */
  const chargeJob = (usd: number): void => {
    if (Number.isFinite(usd) && usd > 0) cost += usd
  }
  const charge = (usd: number): void => {
    if (!Number.isFinite(usd) || usd <= 0) return
    chargeJob(usd)
    budget.spend(usd)
  }
  const handlers: Record<string, ToolHandler> = {}
  for (const d of defs) {
    const h = offered.handlers[d.name]
    if (!h) continue
    handlers[d.name] = async (input, ctx): Promise<ToolOutcome> => {
      // A tool may spend money itself (a paid lookup): not once the parent's is gone.
      if (budget.left <= 0)
        return { content: text(`Not run: ${new BudgetSpent().message}.`), isError: true }
      onStep?.(toolLabel(d.name, input), cost)
      const out = await h(input, ctx)
      if (out.costUsd) charge(out.costUsd)
      if (!out.isError)
        for (const u of readUrls(d.name, input, textOf(out.content)))
          if (!sources.includes(u) && sources.length < MAX_SOURCES) sources.push(u)
      return out
    }
  }
  const caps = jobCaps(role, env.costCapUsd)
  // The job's runner task carries the parent's id: tools that key by task (the paid-search
  // budget, audit lines) count it as the parent's.
  const parentId = parent.task().id
  const deps: RunnerDeps = {
    model: {
      plan: async () => ({ plan: null }),
      turn: async (req, s) => {
        const done = await budget.reserve(s)
        let usd = 0
        try {
          // Raced: a call that ignores the abort must not keep its reservation.
          const r = await raced(env.turn(req, s), s)
          usd = env.costOf(r.model, r.usage)
          return r
        } finally {
          done(usd)
          chargeJob(usd)
          onStep?.('', cost)
        }
      }
    },
    handlers,
    publish: () => {},
    speak: () => {},
    countdown: async () => 'go',
    // A job never grows past its caps: it stops and reports what it has.
    askContinue: async () => false,
    costOf: env.costOf,
    now: env.now,
    newId: () => parentId,
    ...(env.log ? { log: env.log } : {}),
    between: async (s) => {
      await env.hold?.(s)
      if (budget.left <= 0) throw new BudgetSpent()
      return []
    }
  }
  const result = (status: JobResult['status'], t: string): JobResult => ({
    role,
    task,
    status,
    text: clip(redactForModel(t), RESULT_MAX),
    sources,
    costUsd: cost
  })
  // The job's own signal: the parent's cancel, or its wall-clock cap even in the middle of a
  // tool or model call (a confirm waiting in the Tasks list, a slow connector), so a stuck
  // call cannot hold its pool place for ever. Handlers get this signal and stop with it.
  const own = new AbortController()
  const onParent = (): void => own.abort(signal.reason)
  if (signal.aborted) own.abort(signal.reason)
  else signal.addEventListener('abort', onParent, { once: true })
  const timer = setTimeout(() => own.abort(new JobTimeLimit(caps.maxWallMs)), caps.maxWallMs)
  try {
    // Ledger lines: origin subagent, inside the parent's scope (task, automation, buddy).
    const r = await withUsageScope({ origin: 'subagent', feature: `subagent-${role}` }, () =>
      runAgent(
        {
          prompt: task,
          context: {},
          tools: ['finish'],
          extraTools: defs,
          cancelWindowMs: 0,
          skipPlan: true,
          system: spec.system,
          firstTurn: jobTurn(task, new Date(env.now())),
          caps: { ...caps, maxActions: NO_ACTION_CAP },
          signal: own.signal,
          owner: `subagent:${parentId}`,
          speakSummary: false
        },
        deps
      )
    )
    if (r.status === 'done') {
      const needs = r.needsUserAction?.trim()
      const parts = [
        r.summary,
        needs ? (/^needs:/i.test(needs) ? needs : `needs: ${needs}`) : '',
        r.report ?? ''
      ]
      return result('done', parts.filter(Boolean).join('\n'))
    }
    return result('stopped', r.summary)
  } catch (e) {
    if (signal.aborted) throw e
    if (e instanceof BudgetSpent) return result('stopped', `Stopped: ${e.message}.`)
    if (own.signal.reason instanceof JobTimeLimit)
      return result('stopped', `Stopped: ${own.signal.reason.message}.`)
    return result('failed', `It failed: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onParent)
  }
}

/** The run_subagents handler for one parent. */
export function runSubagentsHandler(env: SubagentEnv): ToolHandler {
  return async (raw, ctx): Promise<ToolOutcome> => {
    const parsed = runSubagentsInput.safeParse(raw)
    if (!parsed.success)
      return { content: text('Invalid run_subagents input: give 1 to 6 jobs.'), isError: true }
    const jobs = parsed.data.jobs
      .map((j) => ({ role: j.role, task: j.task.trim() }))
      .filter((j) => isRole(j.role) && j.task)
    if (!jobs.length) return { content: text('Give each job a role and a task.'), isError: true }
    if (jobs.length > MAX_JOBS)
      return { content: text(`At most ${MAX_JOBS} jobs per call.`), isError: true }

    const offered = await env.tools()
    // Before any turn is measured, one is guessed at a quarter of a job's cost cap.
    const budget = new SharedBudget(
      ctx.remainingUsd?.() ?? Number.POSITIVE_INFINITY,
      env.costCapUsd / 4
    )
    const views: SubJob[] = jobs.map((j) => ({
      role: j.role,
      task: clip(j.task, TASK_SHOWN),
      status: 'queued',
      costUsd: 0
    }))
    let active = 0
    const emit = (): void => {
      if (ctx.callId && !ctx.signal.aborted)
        ctx.report?.({ type: 'jobs', callId: ctx.callId, jobs: views.map((v) => ({ ...v })) })
    }
    const setActive = (d: number): void => {
      active += d
      if (!ctx.signal.aborted) env.onActive?.(active)
    }
    emit()
    // The pool may start a job later, from another job's context: keep this task's scope.
    const usage = currentUsageScope()
    let results: JobResult[]
    try {
      results = await Promise.all(
        jobs.map((j, i) =>
          env.pool.run(
            async () => {
              try {
                const r = await runInUsageScope(usage, () =>
                  runJob(j.role, j.task, offered, env, budget, ctx, ctx.signal, (label, cost) => {
                    views[i] = { ...views[i], costUsd: cost, ...(label ? { step: label } : {}) }
                    emit()
                  })
                )
                views[i] = {
                  role: views[i].role,
                  task: views[i].task,
                  status: r.status,
                  costUsd: r.costUsd,
                  result: clip(r.text, 600)
                }
                emit()
                return r
              } finally {
                setActive(-1)
              }
            },
            ctx.signal,
            () => {
              setActive(1)
              views[i] = { ...views[i], status: 'running' }
              emit()
            }
          )
        )
      )
    } finally {
      if (!ctx.signal.aborted) env.onActive?.(0)
    }
    const done = results.filter((r) => r.status === 'done').length
    const block = results.map(fenceResult).join('\n')
    const head = `${done} of ${results.length} ${results.length === 1 ? 'job' : 'jobs'} finished.`
    return {
      content: text(`${head}\n${block}`),
      costUsd: budget.total,
      label: `${results.length} ${results.length === 1 ? 'helper' : 'helpers'}, ${done} done`,
      ...(done ? {} : { isError: true })
    }
  }
}
