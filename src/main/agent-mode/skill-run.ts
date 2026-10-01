// Foreground skill runs (11 T04): the skill's permissions as a guard in front of every agent
// tool call, its steps.json run without the model (input lane, policy gate, verify after each
// step), and the run's audit line and history entry. session.ts decides the order: steps
// first when the skill has them, the model with the skill's instructions after drift or when
// it has none.
import type { AgentTask } from '@shared/events'
import type { SkillRunRecord } from '@shared/types'
import { executeActions } from '../actions/executor'
import type { Decision } from '../actions/safety'
import { matchSkill, appNameOf } from '../ai/skills'
import { requireAgent } from '../agent/instance'
import * as commands from '../agent/commands'
import { writeAudit, type AuditResult } from '../audit/log'
import { log } from '../logger'
import { flattenElements } from '../query/uia-list'
import { getSkillRegistry, loadSkillSteps, recordSkillRun } from '../skills'
import {
  APP_CHECKED_TOOLS,
  checkSkillCall,
  classifyToolCall,
  stepTool,
  type SkillCall
} from '../skills/permissions'
import type { LoadedSkill } from '../skills/registry'
import { runSkillSteps, driftNote, type StepsOutcome } from '../skills/step-runner'
import {
  describeSkillStep,
  fillStepParams,
  needsInput,
  type SkillStep,
  type StepsFile
} from '../skills/steps'
import { askUser as askConfirm } from './confirm'
import { askUser, type AskIo } from './ask'
import type { TaskEnv } from './handlers'
import { launchApp, waitProbe } from './handlers'
import { inputLane, withInputLane } from './input-lane'
import type { ToolOutcome } from './runner'
import { closeSteps, enterStep, newTask, withPlan } from './task'
import { waitFor } from './wait-for'

const UIA_TIMEOUT_MS = 2000
const UIA_MAX_NODES = 1000

/** Checks one tool call; null = allowed (after the user's OK when the skill asks every time). */
export type ToolGuard = (
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal
) => Promise<ToolOutcome | null>

/** Where a skill's guard speaks a denial and asks "confirm every action" questions. */
export interface GuardHost {
  speak(text: string): void
  /** Default: the bar's confirm card. Background runs queue the question in the Tasks list. */
  confirm?(text: string, signal: AbortSignal): Promise<boolean>
}

export interface SkillHost extends GuardHost {
  publish(task: AgentTask): void
  ask: AskIo
}

/** App-pack id of the foreground window, else its process name; null when unknown. */
export async function foregroundApp(signal?: AbortSignal): Promise<string | null> {
  try {
    const w = await commands.activeWindow(requireAgent(), { signal, timeoutMs: UIA_TIMEOUT_MS })
    return matchSkill({ process: w.process, title: w.title })?.id ?? appNameOf(w.process) ?? null
  } catch {
    return null
  }
}

const CONFIRM_DECISION: Decision = {
  risk: 'medium',
  reason: 'this skill asks before every action',
  needsConfirm: true
}

function callText(call: SkillCall, input: Record<string, unknown>): string {
  switch (call.kind) {
    case 'launch':
      return `Start ${call.app}`
    case 'navigate':
      return `Open ${call.url}`
    case 'connector':
      return `Use ${call.tool.replace(/^mcp__[a-z0-9-]+__/, `${call.server}: `)}`
    default: {
      if (call.tool === 'keys') return `Press ${String(input.combo ?? '')}`
      const t = input.target as { ref?: string } | undefined
      return `${String(input.op ?? call.tool).replace(/_/g, ' ')}${t?.ref ? ` “${t.ref}”` : ''}`
    }
  }
}

/** The permission check of one skill for one task. Denials are spoken once and audited. */
export function skillGuard(
  s: LoadedSkill,
  env: Pick<TaskEnv, 'taskId'>,
  host: GuardHost
): ToolGuard {
  const registry = getSkillRegistry()
  const trust = registry ? registry.trustOf(s) : s.baseTrust
  const m = s.manifest
  const spoken = new Set<string>()
  return async (tool, input, signal) => {
    const app =
      APP_CHECKED_TOOLS.includes(tool) && m.apps.length ? await foregroundApp(signal) : null
    const call = classifyToolCall(tool, input, app)
    const v = checkSkillCall(m, trust, call)
    if (!v.ok) {
      deniedAudit(env.taskId, s.manifest.name, call, v.reason)
      log('skip', `skill ${m.name}: ${tool} denied (${v.reason})`)
      if (!spoken.has(v.spoken)) {
        spoken.add(v.spoken)
        host.speak(v.spoken)
      }
      return { content: [{ type: 'text', text: v.reason }], isError: true }
    }
    if (!v.confirm) return null
    const text = `${m.name}: ${callText(call, input)}`
    const ok = host.confirm
      ? await host.confirm(text, signal)
      : (await askConfirm(text, CONFIRM_DECISION)) !== 'deny'
    if (ok) return null
    return {
      content: [
        { type: 'text', text: 'E_DENIED: the user said no to this action. Do not retry it.' }
      ],
      isError: true
    }
  }
}

function deniedAudit(taskId: string, skill: string, call: SkillCall, reason: string): void {
  writeAudit({
    t: new Date().toISOString(),
    task: taskId,
    origin: 'agent',
    action: {
      type: call.tool,
      element: `skill ${skill}`,
      ...(call.kind === 'navigate' ? { url: call.url } : {}),
      ...(call.kind === 'launch' ? { appId: call.app } : {})
    },
    risk: 'blocked',
    decision: 'blocked',
    result: 'denied',
    ms: 0,
    reason: reason.replace(/^E_DENIED: /, '')
  })
}

/** The run's own audit line: which skill ran, how, and how it ended. */
export function auditSkillRun(
  taskId: string,
  skill: string,
  how: SkillRunRecord['how'],
  status: SkillRunRecord['status'],
  ms: number
): void {
  const result: AuditResult =
    status === 'done'
      ? 'ok'
      : status === 'cancelled' || status === 'stopped'
        ? 'cancelled'
        : status === 'denied'
          ? 'denied'
          : 'error'
  writeAudit({
    t: new Date().toISOString(),
    task: taskId,
    origin: 'agent',
    action: { type: 'skill_run', element: skill, how, status },
    risk: 'low',
    decision: 'auto',
    result,
    ms
  })
}

/** Audit line + history entry for one finished foreground run. */
export function finishSkillRun(
  env: TaskEnv,
  skill: string,
  run: Omit<SkillRunRecord, 'at' | 'ms'>,
  startedAt: number
): void {
  const ms = Date.now() - startedAt
  auditSkillRun(env.taskId, skill, run.how, run.status, ms)
  recordSkillRun(skill, { ...run, at: startedAt, ms })
  log('done', `skill ${skill} ${run.status} (${run.how}, ${run.actions} actions, ${ms} ms)`)
}

// ---- steps.json ----

export type StepsRun =
  | { kind: 'none' }
  | { kind: 'outcome'; outcome: StepsOutcome; labels: string[]; steps: SkillStep[] }
  /** steps.json is broken or a value is bad: the model runs the skill instead. */
  | { kind: 'skipped'; reason: string }

/** The skill's steps, read and filled; values still missing are asked for by voice. */
async function prepareSteps(
  s: LoadedSkill,
  args: { name: string; value: string }[] | undefined,
  host: SkillHost,
  signal: AbortSignal
): Promise<{ file: StepsFile; filled: SkillStep[] } | { skip: string } | null> {
  let file: StepsFile | null
  try {
    file = loadSkillSteps(s.manifest.name)
  } catch (e) {
    return { skip: `steps.json: ${(e as Error).message}` }
  }
  if (!file) return null
  const given = [...(args ?? [])]
  for (let round = 0; round < 4; round++) {
    const f = fillStepParams(file.steps, s.manifest, given)
    if (f.problems.length) return { skip: f.problems.join('; ') }
    if (!f.missing.length) return { file, filled: f.steps }
    const key = f.missing[0]
    const what = s.manifest.params[key]?.description ?? key.replace(/_/g, ' ')
    const answer = await askUser(`What should I use for ${what}?`, host.ask, signal)
    if (!answer) return { skip: `no value for ${key}` }
    given.push({ name: key, value: answer })
  }
  return { skip: 'too many missing values' }
}

/** Runs a skill's steps.json in the foreground. Throws the abort reason when cancelled. */
export async function runStepsForeground(
  s: LoadedSkill,
  env: TaskEnv,
  args: { name: string; value: string }[] | undefined,
  host: SkillHost,
  signal: AbortSignal
): Promise<StepsRun> {
  const prepared = await prepareSteps(s, args, host, signal)
  if (!prepared) return { kind: 'none' }
  if ('skip' in prepared) {
    log('fail', `skill ${s.manifest.name}: steps not used (${prepared.skip})`)
    return { kind: 'skipped', reason: prepared.skip }
  }
  const { file, filled } = prepared
  const labels = file.steps.map(describeSkillStep)
  const guard = skillGuard(s, env, host)
  let task = withPlan(newTask(env.taskId, env.prompt, Date.now()), `run ${s.manifest.name}`, labels)
  task = { ...task, phase: 'running' }
  host.publish(task)

  const release = needsInput(filled) ? await inputLane().acquire(env.taskId, signal) : null
  try {
    const outcome = await runSkillSteps(
      filled,
      {
        elements: async (sig) => {
          const snap = await commands.uiaSnapshot(
            requireAgent(),
            { scope: 'foreground', maxNodes: UIA_MAX_NODES, interactiveOnly: false },
            { signal: sig, timeoutMs: UIA_TIMEOUT_MS }
          )
          return flattenElements(snap.root).map((f) => f.node)
        },
        execute: async (actions, sig) => {
          const r = await withInputLane(
            env.taskId,
            () =>
              executeActions(actions, {
                signal: sig,
                origin: 'agent',
                taskId: env.taskId,
                userText: env.prompt,
                task: env.state,
                observedText: env.observedText,
                preview: false,
                pauseMs: 100
              }),
            { signal: sig }
          )
          return {
            executed: r.executed,
            cancelled: r.cancelled,
            ...(r.denied ? { denied: `E_DENIED: ${r.denied.reason}` } : {})
          }
        },
        waitFor: (cond, ms, sig) => waitFor(cond, ms, waitProbe, sig),
        launchApp: async (app, sig) => {
          const r = await launchApp({ app }, env, sig)
          const detail = r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ')
          if (!r.isError) return { ok: true, detail }
          return detail.startsWith('E_DENIED')
            ? { ok: false, denied: detail, detail }
            : { ok: false, detail }
        },
        permit: async (step, sig) => {
          const tool = stepTool(step)
          const input: Record<string, unknown> =
            step.do === 'navigate'
              ? { url: step.url }
              : step.do === 'launch_app'
                ? { app: step.app }
                : step.do === 'keys'
                  ? { combo: step.combo }
                  : { op: step.do }
          const refusal = await guard(tool, input, sig)
          return refusal ? (refusal.content[0] as { text: string }).text : null
        },
        sleep: (ms, sig) =>
          new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ms)
            sig.addEventListener('abort', () => (clearTimeout(t), reject(sig.reason)), {
              once: true
            })
          }),
        now: () => Date.now(),
        progress: (i, _total, label) => {
          task = enterStep(task, i + 1, label)
          host.publish(task)
        }
      },
      signal,
      labels
    )
    task = {
      ...closeSteps(task, outcome.status === 'done'),
      phase: outcome.status === 'done' ? 'done' : 'failed'
    }
    host.publish(task)
    return { kind: 'outcome', outcome, labels, steps: file.steps }
  } catch (e) {
    task = { ...closeSteps(task, false), phase: 'aborted' }
    host.publish(task)
    throw e
  } finally {
    release?.()
  }
}

/** The model's task after drift: the original request plus what ran and where it went off. */
export function afterDrift(prompt: string, run: Extract<StepsRun, { kind: 'outcome' }>): string {
  if (run.outcome.status !== 'drift') return prompt
  return `${prompt}\n\n${driftNote(run.steps, run.outcome, run.labels)}`
}
