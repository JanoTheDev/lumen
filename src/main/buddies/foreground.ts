// A buddy on screen (08 T52): a buddy that may use the screen or the mouse and keyboard runs as
// the foreground agent task when the user is at the PC, under an envelope made from its own
// permissions (the same skill guard as its background runs, with the foreground tool names), its
// usage scope, gate and audit origin (buddy + buddyId), its model role, per-run cost cap,
// notebook (memory_write), helpers and skills like a background run, a record in its run
// history, and `buddy.working` on the bus for the on-screen buddy's colour and name tag (T53).
// Otherwise it runs in the background, where it never takes the screen. The countdown, input
// lane and confirm cards stay the foreground task's own.
import type { Buddy } from '@shared/buddies'
import type { ModelResponse, SkillManifest } from '@shared/types'
import type { RunResult } from '../agent-mode/runner'
import type { UnderEnvelope } from '../agent-mode/session'
import type { SkillEnvelope } from '../agent-mode/skill-envelope'
import type { GuardHost } from '../agent-mode/skill-run'
import type { LoadedSkill } from '../skills/registry'
import {
  buddyContext,
  buddyManifest,
  buddyPrompt,
  buddyRunSettings,
  buddyRunTitle,
  buddyUserText,
  type RunBuddyOpts
} from './run'
import type { ScreenRunEnd } from './screen-runs'

/** It asks for the screen or the mouse and keyboard. */
export function needsScreen(b: Pick<Buddy, 'permissions'>): boolean {
  return b.permissions.screen || b.permissions.input
}

/**
 * Tools the buddy may use on screen: finish, ask_user and memory_write (its notebook) always,
 * run_subagents when it may split work, the rest by permission.
 */
export function foregroundTools(b: Buddy): string[] {
  const p = b.permissions
  const sees = p.screen || p.input
  return [
    'finish',
    'ask_user',
    'memory_write',
    ...(b.subagents ? ['run_subagents'] : []),
    ...(sees ? ['observe', 'wait_for'] : []),
    ...(p.input ? ['act', 'keys', 'launch_app'] : []),
    ...(p.input && p.network.length ? ['navigate'] : []),
    ...p.tools.filter((t) => ['lookup_howto', 'create_file', 'memory_search'].includes(t)),
    ...(b.report === 'cards' ? ['present_cards'] : [])
  ]
}

/** The buddy's stand-in skill manifest with the foreground tool names. */
export function buddyForegroundManifest(b: Buddy): SkillManifest {
  const m = buddyManifest(b)
  return { ...m, context: 'foreground', tools: foregroundTools(b) }
}

export function buddyForegroundStandIn(b: Buddy): LoadedSkill {
  return {
    manifest: buddyForegroundManifest(b),
    dir: '',
    origin: 'user',
    baseTrust: b.trust,
    hasSteps: false,
    warnings: []
  }
}

export type Lane = 'foreground' | 'background'

/**
 * Where a run goes: on screen only for a buddy that needs it, with the user present and no other
 * foreground task; a scheduled run also needs its automation's pre-approval.
 */
export function chooseLane(
  b: Pick<Buddy, 'permissions'>,
  s: {
    trigger: RunBuddyOpts['trigger']
    present: boolean
    agentBusy: boolean
    preApproved?: boolean
  }
): Lane {
  if (!needsScreen(b) || s.agentBusy || !s.present) return 'background'
  if (s.trigger === 'schedule' && !s.preApproved) return 'background'
  return 'foreground'
}

/** The foreground task's goal: who it is, its job, the words, its notebook as data. */
export function foregroundPrompt(b: Buddy, opts: RunBuddyOpts, notebook: string): string {
  const notes = buddyContext(notebook)
  return [
    buddyPrompt(b, opts),
    'You are working on the user’s screen now; they can see you and say “stop”.',
    ...(notes ? ['', notes] : [])
  ].join('\n')
}

type Envelope = (s: LoadedSkill, taskId: string, host: GuardHost) => SkillEnvelope

export interface ForegroundDeps {
  /** session.runAgentTask with the context of the window in front. */
  runTask(
    prompt: string,
    signal: AbortSignal,
    opts: { userText: string; observedText: string; underEnvelope: UnderEnvelope }
  ): Promise<ModelResponse>
  envelope: Envelope
  notebook(id: string): string
  /** memory_write: one note into the buddy's notebook. */
  memoryWrite(id: string, fact: string): 'ok' | 'rejected' | 'disabled'
  /** The buddy's run history (its on-screen runs). */
  runs: {
    start(buddyId: string, taskId: string, title: string, at: number): void
    end(taskId: string, e: ScreenRunEnd): void
  }
  working(buddyId: string, active: boolean): void
  now(): number
}

const PHASE: Record<RunResult['status'], ScreenRunEnd['phase']> = {
  done: 'done',
  failed: 'failed',
  stopped: 'cancelled',
  paused: 'paused'
}

/** Runs the buddy as the foreground agent task; `buddy.working` brackets it. */
export async function runBuddyForeground(
  b: Buddy,
  opts: RunBuddyOpts,
  signal: AbortSignal,
  deps: ForegroundDeps
): Promise<ModelResponse> {
  const notebook = deps.notebook(b.id)
  const standIn = buddyForegroundStandIn(b)
  const { maxCostUsd, ...settings } = buddyRunSettings(b)
  let taskId: string | null = null
  let ended = false
  deps.working(b.id, true)
  try {
    return await deps.runTask(foregroundPrompt(b, opts, notebook), signal, {
      userText: buddyUserText(b, opts),
      observedText: notebook,
      underEnvelope: {
        make: (id, host) => deps.envelope(standIn, id, host),
        scope: { origin: 'buddy', buddyId: b.id },
        gate: { origin: 'buddy', buddyId: b.id },
        ...settings,
        caps: { maxCostUsd },
        memoryWrite: (fact) => deps.memoryWrite(b.id, fact),
        onStart: (id) => {
          taskId = id
          deps.runs.start(b.id, id, buddyRunTitle(b, opts), deps.now())
        },
        onEnd: (r) => {
          ended = r.status !== 'paused'
          deps.runs.end(r.task.id, {
            phase: PHASE[r.status],
            ...(r.summary ? { summary: r.summary } : {}),
            costUsd: r.task.counters.costUsd,
            endedAt: deps.now()
          })
        }
      }
    })
  } catch (e) {
    if (taskId && !ended) {
      const cancelled = signal.aborted || (e as Error).name === 'AbortError'
      deps.runs.end(taskId, {
        phase: cancelled ? 'cancelled' : 'failed',
        summary: cancelled ? 'Stopped.' : (e as Error).message,
        endedAt: deps.now()
      })
    }
    throw e
  } finally {
    deps.working(b.id, false)
  }
}
