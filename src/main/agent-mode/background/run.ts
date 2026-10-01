// One background run on the shared agent-loop runner: background tool set (plus skills), no
// plan, no countdown, no input lane, nothing spoken by the runner. A cap (calls, cost, wall
// time) pauses the task with a queued "Keep going?" question. In a skill run, file changes
// (create / rename / move) ask first in the Tasks list unless the skill is trusted and not risky.
import type { SkillManifest, SkillTrust } from '@shared/types'
import type {
  AgentMessage,
  SystemBlock,
  ToolDef,
  ToolTurnResult,
  Usage
} from '../../ai/providers/types'
import { confirmsEveryAction } from '../../skills/permissions'
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
  /** The installed skill by name, with its trust (default: the skill registry). */
  skillInfo?(name: string): Promise<RunSkillInfo | null>
  /**
   * The skills whose trust decides file-change confirms: the task's own and, for a helper, its
   * parent's (default: the task's own skill). Every one must be trusted to skip the question.
   */
  fileSkills?: string[]
  /** Text the task read (pages, files, how-to steps): the policy's injection check. */
  observe?(text: string): void
}

/** Tools whose results are text the task observed (not the user's words). */
export const OBSERVED_TOOLS = new Set(['fetch_url', 'read_file', 'read_document', 'lookup_howto'])

/** The observed tools' successful results go to `observe` (the policy's observedText). */
export function observing(
  handlers: Record<string, ToolHandler>,
  observe: (text: string) => void
): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = { ...handlers }
  for (const name of OBSERVED_TOOLS) {
    const h = handlers[name]
    if (!h) continue
    out[name] = async (input, ctx) => {
      const r = await h(input, ctx)
      if (!r.isError) {
        const t = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
        if (t.trim()) observe(t)
      }
      return r
    }
  }
  return out
}

/** Tools that change the user's files. */
export const FILE_WRITE_TOOLS = new Set(['create_file', 'rename_file', 'move_file'])

export interface RunSkillInfo {
  name: string
  manifest: SkillManifest
  trust: SkillTrust
}

/**
 * Whether a file change in this run asks the user first: in a skill run, unless the skill is
 * known, trusted and not risky (a community skill that left out `tools:` must not rename or
 * move files unasked). Pure.
 */
export function fileWriteNeedsConfirm(skillRun: boolean, skill: RunSkillInfo | null): boolean {
  if (!skillRun) return false
  return !skill || confirmsEveryAction(skill.manifest, skill.trust)
}

/** What the file change is, for the question. */
export function fileWriteText(tool: string, input: Record<string, unknown>): string {
  const str = (k: string): string => String(input[k] ?? '').slice(0, 120)
  const base = (p: string): string => p.split(/[\\/]/).pop() ?? p
  if (tool === 'rename_file') return `rename ${base(str('path'))} to ${str('newName')}`
  if (tool === 'move_file') return `move ${base(str('path'))} to ${str('toFolder')}`
  return `save a file "${str('name') || str('title')}"`
}

async function registrySkill(name: string): Promise<RunSkillInfo | null> {
  try {
    const { getSkillRegistry } = await import('../../skills')
    const reg = getSkillRegistry()
    const s = reg?.get(name)
    return reg && s ? { name, manifest: s.manifest, trust: reg.trustOf(s) } : null
  } catch {
    return null
  }
}

/** The file-changing handlers behind a queued "Allow it?" when the run's skill needs it. */
export function fileWriteGuarded(
  handlers: Record<string, ToolHandler>,
  needs: () => Promise<{ confirm: boolean; skill: string }>,
  ask: (text: string) => Promise<boolean>,
  audit: BgPorts['audit']
): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = { ...handlers }
  for (const name of FILE_WRITE_TOOLS) {
    const h = handlers[name]
    if (!h) continue
    out[name] = async (input, ctx) => {
      const n = await needs()
      if (n.confirm && !(await ask(`${n.skill}: ${fileWriteText(name, input)}. Allow it?`))) {
        audit({ type: name }, 'denied', 'the user said no')
        return {
          content: [
            {
              type: 'text',
              text: 'E_DENIED: the user said no to this file change. Do not retry it.'
            }
          ],
          isError: true
        }
      }
      return h(input, ctx)
    }
  }
  return out
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
  const own = { ...createBackgroundHandlers(env.ports), ...skills?.handlers, ...more.handlers }
  const base = env.observe ? observing(own, env.observe) : own
  const skillRun = !!task.skill || !!env.toolGuard
  // A helper inside a skill run goes by its parent's skill too (it has none of its own).
  const fileSkills = env.fileSkills ?? (task.skill ? [task.skill] : [])
  let need: Promise<{ confirm: boolean; skill: string }> | null = null
  const all = skillRun
    ? fileWriteGuarded(
        base,
        () =>
          (need ??= (async () => {
            const infos = await Promise.all(
              fileSkills.map((n) => (env.skillInfo ?? registrySkill)(n).catch(() => null))
            )
            return {
              confirm: !infos.length || infos.some((i) => fileWriteNeedsConfirm(true, i)),
              skill: fileSkills.length ? `Skill “${fileSkills[0]}”` : 'This skill task'
            }
          })()),
        async (text) => {
          const a = await ctl.ask(text, ['Allow', 'Deny'])
          return !ctl.signal.aborted && /^(allow|yes|ok|okay|sure)\b/i.test(a.trim())
        },
        env.ports.audit
      )
    : base
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
