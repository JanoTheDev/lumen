// One background run on the shared agent-loop runner: background tool set (plus skills), no
// plan, no countdown, no input lane, nothing spoken by the runner. A cap (calls, cost, wall
// time) pauses the task with a queued "Keep going?" question.
import type {
  AgentMessage,
  SystemBlock,
  ToolDef,
  ToolTurnResult,
  Usage
} from '../../ai/providers/types'
import { runAgent, type Caps, type RunnerDeps, type ToolHandler } from '../runner'
import type { ToolGuard } from '../skill-run'
import { createBackgroundHandlers, type BgPorts } from './handlers'
import type { RunOutcome, TaskControl } from './manager'
import { BACKGROUND_SYSTEM, backgroundTurn } from './prompts'
import { backgroundToolDefs } from './tools'

export interface BackgroundCaps {
  maxModelCalls: number
  maxCostUsd: number
  maxWallMs: number
}

export interface BgRunEnv {
  caps: BackgroundCaps
  ports: BgPorts
  turn(
    req: { system: SystemBlock[]; tools: ToolDef[]; messages: AgentMessage[] },
    signal: AbortSignal
  ): Promise<ToolTurnResult>
  costOf(model: string, usage: Usage): number
  now(): number
  skills?: {
    defs: ToolDef[]
    handlers: Record<string, ToolHandler>
    index: string
    skill?: { name: string; text?: string }
  }
  log?(tag: string, msg: string): void
  /** More tools for this run (MCP connectors); a failure leaves them out. */
  moreTools?(): Promise<{ defs: ToolDef[]; handlers: Record<string, ToolHandler> }>
  /**
   * Checked before every tool call: a reason refuses the call (E_DENIED, audited). Routines
   * skip high-risk calls they did not pre-approve.
   */
  guard?(tool: string, input: Record<string, unknown>): string | null
  /** The skill envelope(s) of the run: checked after `guard` (denials are audited there). */
  toolGuard?: ToolGuard
  /** Whether a tool is offered to the model at all (a skill run offers only what it may use). */
  offers?(tool: string): boolean
}

/** Every handler behind a skill guard (async; it may ask the user first). */
export function skillGuarded(
  handlers: Record<string, ToolHandler>,
  guard: ToolGuard
): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {}
  for (const [name, h] of Object.entries(handlers))
    out[name] = async (input, ctx) => (await guard(name, input, ctx.signal)) ?? h(input, ctx)
  return out
}

/** Every handler behind `guard`. */
export function guarded(
  handlers: Record<string, ToolHandler>,
  guard: NonNullable<BgRunEnv['guard']>,
  audit: BgPorts['audit']
): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {}
  for (const [name, h] of Object.entries(handlers))
    out[name] = (input, ctx) => {
      const deny = guard(name, input)
      if (!deny) return h(input, ctx)
      audit({ type: name }, 'denied', deny)
      return Promise.resolve({
        content: [{ type: 'text', text: `E_DENIED: ${deny}` }],
        isError: true
      })
    }
  return out
}

const KEEP_GOING_RE = /^(keep going|yes|go on|continue|carry on|sure|ok|okay)\b/i

/** Background tasks never send input, so the action cap never applies. */
const NO_ACTION_CAP = 1_000_000

export function capsFor(c: BackgroundCaps): Partial<Caps> {
  return {
    maxActions: NO_ACTION_CAP,
    maxModelCalls: c.maxModelCalls,
    maxCostUsd: c.maxCostUsd,
    maxWallMs: c.maxWallMs
  }
}

export async function runBackground(ctl: TaskControl, env: BgRunEnv): Promise<RunOutcome> {
  const task = ctl.task()
  const skills = env.skills
  const more = env.moreTools
    ? await env.moreTools().catch(() => ({ defs: [] as ToolDef[], handlers: {} }))
    : { defs: [] as ToolDef[], handlers: {} }
  const all = { ...createBackgroundHandlers(env.ports), ...skills?.handlers, ...more.handlers }
  const inner = env.toolGuard ? skillGuarded(all, env.toolGuard) : all
  const handlers = env.guard ? guarded(inner, env.guard, env.ports.audit) : inner
  const offered = (d: ToolDef): boolean => !env.offers || env.offers(d.name)
  const startedAt = task.counters.startedAt

  const deps: RunnerDeps = {
    model: {
      plan: async () => ({ plan: null }),
      turn: (req, signal) => env.turn(req, signal)
    },
    handlers,
    publish: (t) => {
      const c = ctl.task().counters
      if (t.counters.modelCalls !== c.modelCalls || t.counters.costUsd !== c.costUsd)
        ctl.update({
          counters: { modelCalls: t.counters.modelCalls, costUsd: t.counters.costUsd, startedAt }
        })
    },
    speak: () => {},
    countdown: async () => 'go',
    askContinue: async (reason, signal) => {
      ctl.progress(`Paused at the limit of ${reason}`)
      const a = await ctl.ask(`This task reached its limit of ${reason}. Keep going?`, [
        'Keep going',
        'Stop'
      ])
      if (signal.aborted) return false
      return KEEP_GOING_RE.test(a.trim())
    },
    costOf: env.costOf,
    now: env.now,
    newId: () => task.id,
    log: env.log,
    ...(ctl.record ? { observe: ctl.record } : {}),
    ...(ctl.between ? { between: ctl.between } : {})
  }

  const r = await runAgent(
    {
      prompt: task.prompt,
      context: {},
      tools: ['ask_user', 'finish'],
      extraTools: [
        ...backgroundToolDefs({ child: !!task.parentId }),
        ...(skills?.defs ?? []),
        ...more.defs
      ].filter(offered),
      parallelTools: ['spawn_task'],
      cancelWindowMs: 0,
      skipPlan: true,
      system: BACKGROUND_SYSTEM,
      ...(skills?.index ? { systemExtra: skills.index } : {}),
      firstTurn: backgroundTurn(task.prompt, new Date(env.now()), skills?.skill),
      caps: capsFor(env.caps),
      // "Keep going" grows a cap by its starting size.
      capStep: capsFor(env.caps),
      signal: ctl.signal,
      owner: `background:${task.id}`,
      speakSummary: false
    },
    deps
  )
  if (r.status === 'done')
    return {
      status: 'done',
      summary: r.needsUserAction ? `${r.summary} ${r.needsUserAction}` : r.summary,
      ...(r.report ? { report: r.report } : {})
    }
  return { status: 'failed', summary: r.summary }
}
