// Task chat headers (08 T43): status, counters and which buttons the view shows, for each kind
// of chat. Pure; transcript-wire.ts feeds it the live state.
import type { ClaudeSessionView } from '@shared/claude-code'
import type { ChatHeader, ChatPhase, ChatSummary } from '@shared/task-chat'
import type { BackgroundTask } from '@shared/types'
import type { ChatMeta } from './transcript'
import { claudeMeta } from './transcript-claude'

/** A short id for a question's text (the view sends it back with the answer). */
export function questionToken(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `q${h.toString(36)}`
}

/** A Claude session's waiting permission (its id) or question (its text). */
export function claudeToken(p: { kind: string; permId?: string; text: string }): string {
  return p.kind === 'permission' && p.permId ? `p${p.permId}` : questionToken(p.text)
}

const OPEN = new Set(['queued', 'running', 'asking', 'needs-foreground'])
const ACTIVE = new Set(['running', 'asking', 'needs-foreground'])
const OPEN_CHAT = new Set<ChatPhase>(['queued', 'running', 'paused', 'asking', 'confirm'])

export function backgroundPhase(t: BackgroundTask, paused: boolean): ChatPhase {
  if (paused && ACTIVE.has(t.phase)) return 'paused'
  return t.phase === 'needs-foreground' ? 'asking' : t.phase
}

export function backgroundHeader(
  t: BackgroundTask,
  live: { paused: boolean; steps: number; steerable: boolean }
): ChatHeader {
  const open = OPEN.has(t.phase)
  const asking = t.phase === 'asking' || t.phase === 'needs-foreground'
  return {
    id: t.id,
    kind: 'background',
    title: t.title,
    phase: backgroundPhase(t, live.paused),
    steps: live.steps,
    modelCalls: t.counters.modelCalls,
    costUsd: t.counters.costUsd,
    startedAt: t.counters.startedAt,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    ...(asking && t.question
      ? {
          question: {
            text: t.question.text,
            choices: t.question.choices ?? [],
            token: questionToken(t.question.text)
          }
        }
      : {}),
    canStop: open,
    canPause: ACTIVE.has(t.phase) && !live.paused && !t.claude,
    canResume: live.paused && ACTIVE.has(t.phase),
    canRunAgain: !open && !t.claude,
    canSteer: live.steerable || asking
  }
}

export function foregroundHeader(
  id: string,
  meta: ChatMeta,
  live: {
    running: boolean
    steps: number
    question?: { text: string; choices?: string[] }
    confirm?: { id: string; summary: string }
    paused?: boolean
    /** The model loop can hold (a steps.json run cannot). */
    pausable?: boolean
  }
): ChatHeader {
  // A task that was running when Lumen closed (or crashed) did not end on its own.
  const stale =
    !live.running &&
    (meta.phase === 'running' || meta.phase === 'asking' || meta.phase === 'confirm')
  const phase: ChatPhase = stale
    ? 'interrupted'
    : live.confirm
      ? 'confirm'
      : live.running && live.paused
        ? 'paused'
        : meta.phase
  return {
    id,
    kind: 'foreground',
    title: meta.title,
    phase,
    steps: live.steps,
    modelCalls: meta.modelCalls,
    costUsd: meta.costUsd,
    startedAt: meta.startedAt,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    ...(live.running && live.question
      ? {
          question: {
            text: live.question.text,
            choices: live.question.choices ?? [],
            token: questionToken(live.question.text)
          }
        }
      : {}),
    ...(live.running && live.confirm
      ? { confirm: live.confirm.summary, confirmId: live.confirm.id }
      : {}),
    canStop: live.running,
    canPause: live.running && !!live.pausable && !live.paused,
    canResume: live.running && !!live.paused,
    canRunAgain: !live.running,
    canSteer: live.running
  }
}

export function claudeHeader(
  id: string,
  v: ClaudeSessionView | null,
  meta: ChatMeta | undefined,
  steps: number
): ChatHeader | null {
  const m = v ? claudeMeta(v) : meta
  if (!m) return null
  const p = v?.pending
  const busy = !!v && (m.phase === 'running' || m.phase === 'asking')
  return {
    id,
    kind: 'claude',
    title: m.title,
    phase: v ? m.phase : m.phase === 'running' || m.phase === 'asking' ? 'interrupted' : m.phase,
    steps,
    modelCalls: m.modelCalls,
    costUsd: m.costUsd,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    ...(p
      ? {
          question: {
            text: p.kind === 'permission' && p.command ? `${p.text}\n${p.command}` : p.text,
            choices:
              p.kind === 'permission' ? ['Allow', 'Always allow', 'Deny'] : (p.choices ?? []),
            token: claudeToken(p)
          }
        }
      : {}),
    canStop: busy,
    canPause: false,
    canResume: false,
    canRunAgain: false,
    canSteer: !!v && p?.kind !== 'permission',
    ...(m.project ? { project: m.project } : {})
  }
}

export const MAX_SUMMARIES = 40

/**
 * The view's task list: top-level background tasks (a Claude session's tasks fold into the
 * session's chat), foreground tasks and Claude sessions, open ones first, newest first.
 */
export function chatSummaries(
  tasks: readonly BackgroundTask[],
  others: readonly { id: string; meta: ChatMeta }[],
  live: { pausedIds?: ReadonlySet<string>; runningFg?: string | null } = {}
): ChatSummary[] {
  const out = new Map<string, ChatSummary>()
  for (const { id, meta } of others) {
    let phase = meta.phase
    if (meta.kind === 'foreground' && id !== live.runningFg && OPEN_CHAT.has(phase))
      phase = 'interrupted'
    else if (meta.kind === 'foreground' && live.pausedIds?.has(id)) phase = 'paused'
    out.set(id, { id, kind: meta.kind, title: meta.title, phase, at: meta.startedAt })
  }
  for (const t of tasks) {
    if (t.parentId) continue
    if (t.claude) {
      const s = out.get(t.claude.id)
      const phase = backgroundPhase(t, false)
      // The session's newest stretch decides its row.
      if (!s || t.counters.startedAt >= s.at || OPEN.has(t.phase))
        out.set(t.claude.id, {
          id: t.claude.id,
          kind: 'claude',
          title: t.title,
          phase,
          at: Math.max(t.counters.startedAt, s?.at ?? 0),
          ...(t.unseen ? { unseen: true } : {})
        })
      continue
    }
    out.set(t.id, {
      id: t.id,
      kind: 'background',
      title: t.title,
      phase: backgroundPhase(t, !!live.pausedIds?.has(t.id)),
      at: t.counters.startedAt,
      ...(t.unseen ? { unseen: true } : {})
    })
  }
  const rank = (s: ChatSummary): number => (OPEN_CHAT.has(s.phase) ? 0 : 1)
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || b.at - a.at).slice(0, MAX_SUMMARIES)
}

/** The chat a Tasks-list row opens: a Claude session's tasks open the session's chat. */
export function chatIdForTask(t: Pick<BackgroundTask, 'id' | 'claude'>): string {
  return t.claude?.id ?? t.id
}
