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
  /**
   * Checked before every tool call: a reason refuses the call (E_DENIED, audited). Routines
   * skip high-risk calls they did not pre-approve.
   */
  guard?(tool: string, input: Record<string, unknown>): string | null
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
  const all = { ...createBackgroundHandlers(env.ports), ...skills?.handlers }
  const handlers = env.guard ? guarded(all, env.guard, env.ports.audit) : all
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
    log: env.log
  }

  const r = await runAgent(
    {
      prompt: task.prompt,
      context: {},
      tools: ['ask_user', 'finish'],
      extraTools: [...backgroundToolDefs({ child: !!task.parentId }), ...(skills?.defs ?? [])],
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
