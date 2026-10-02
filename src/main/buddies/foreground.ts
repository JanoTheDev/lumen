// A buddy on screen (08 T52): a buddy that may use the screen or the mouse and keyboard runs as
// the foreground agent task when the user is at the PC, under an envelope made from its own
// permissions (the same skill guard as its background runs, with the foreground tool names), its
// usage scope (origin buddy) and `buddy.working` on the bus for the on-screen buddy's colour and
// name tag (T53). Otherwise it runs in the background, where it never takes the screen.
import type { Buddy } from '@shared/buddies'
import type { ModelResponse, SkillManifest } from '@shared/types'
import type { SkillEnvelope } from '../agent-mode/skill-envelope'
import type { GuardHost } from '../agent-mode/skill-run'
import type { LoadedSkill } from '../skills/registry'
import { buddyContext, buddyManifest, buddyPrompt, buddyUserText, type RunBuddyOpts } from './run'

/** It asks for the screen or the mouse and keyboard. */
export function needsScreen(b: Pick<Buddy, 'permissions'>): boolean {
  return b.permissions.screen || b.permissions.input
}

/** Foreground agent tools the buddy may use: finish and ask_user always, the rest by permission. */
export function foregroundTools(b: Buddy): string[] {
  const p = b.permissions
  const sees = p.screen || p.input
  return [
    'finish',
    'ask_user',
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
    opts: {
      userText: string
      observedText: string
      underEnvelope: {
        make: (taskId: string, host: GuardHost) => SkillEnvelope
        scope: { origin: 'buddy'; buddyId: string }
      }
    }
  ): Promise<ModelResponse>
  envelope: Envelope
  notebook(id: string): string
  working(buddyId: string, active: boolean): void
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
  deps.working(b.id, true)
  try {
    return await deps.runTask(foregroundPrompt(b, opts, notebook), signal, {
      userText: buddyUserText(b, opts),
      observedText: notebook,
      underEnvelope: {
        make: (taskId, host) => deps.envelope(standIn, taskId, host),
        scope: { origin: 'buddy', buddyId: b.id }
      }
    })
  } finally {
    deps.working(b.id, false)
  }
}
