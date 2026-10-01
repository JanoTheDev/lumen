// Home Tasks list (08 T29): pure view helpers (status line, which buttons a task shows).
import type { BackgroundTask } from '@shared/types'

export const MAX_SHOWN = 6

export interface TaskRow {
  id: string
  title: string
  status: string
  phase: BackgroundTask['phase']
  canCancel: boolean
  canRunAgain: boolean
  canOpen: boolean
  question?: { text: string; choices: string[] }
  unseen: boolean
  /** A Claude Code session: Stop instead of Cancel, Open shows the session's chat. */
  claude: boolean
  /** Answer cards of a finished research task ("View results"). */
  cardsId?: string
}

const OPEN = new Set(['queued', 'running', 'asking', 'needs-foreground'])

function cost(usd: number): string {
  return usd >= 0.01 ? ` · $${usd.toFixed(2)}` : ''
}

/** Claude's live phase in words (08 T39): thinking / running a tool / waiting for you. */
export function claudeStatus(t: BackgroundTask): string | null {
  const c = t.claude
  if (!c || (t.phase !== 'running' && t.phase !== 'asking')) return null
  const last = t.progress[t.progress.length - 1]
  if (t.phase === 'asking' || c.phase === 'waiting-permission' || c.phase === 'waiting-answer')
    return 'Waiting for you'
  if (c.phase === 'running-tool') return last ?? 'Running a tool'
  if (c.phase === 'starting') return 'Starting'
  return last && last !== 'Thinking' ? `Thinking · ${last}` : 'Thinking'
}

export function taskRow(t: BackgroundTask): TaskRow {
  const last = t.progress[t.progress.length - 1]
  let status: string
  switch (t.phase) {
    case 'queued':
      status = 'Waiting to start'
      break
    case 'running':
      status = t.helpers
        ? `${t.helpers} ${t.helpers === 1 ? 'helper' : 'helpers'} working`
        : (last ?? 'Working…')
      break
    case 'asking':
      status = 'Needs your answer'
      break
    case 'needs-foreground':
      status = 'Wants to use the mouse'
      break
    case 'done':
      status = t.result?.summary ?? 'Done'
      break
    case 'failed':
      status = t.result?.summary ?? 'Failed'
      break
    case 'cancelled':
      status = 'Cancelled'
      break
    case 'interrupted':
      status = 'Stopped when Lumen closed'
      break
  }
  status = claudeStatus(t) ?? status
  const open = OPEN.has(t.phase)
  // Claude's cost is the user's plan: shown whenever the CLI reported one.
  const showCost = t.phase === 'running' || (!!t.claude && t.phase !== 'queued')
  return {
    id: t.id,
    title: t.title,
    status: `${status}${showCost ? cost(t.counters.costUsd) : ''}`,
    phase: t.phase,
    canCancel: open,
    canRunAgain:
      !t.claude && (t.phase === 'interrupted' || t.phase === 'failed' || t.phase === 'cancelled'),
    // Every task has a chat (08 T43): its transcript, or the session's for Claude.
    canOpen: true,
    ...(t.question && (t.phase === 'asking' || t.phase === 'needs-foreground')
      ? { question: { text: t.question.text, choices: t.question.choices ?? [] } }
      : {}),
    unseen: !!t.unseen,
    claude: !!t.claude,
    ...(t.phase === 'done' && t.result?.cardsId ? { cardsId: t.result.cardsId } : {})
  }
}

/** Open tasks first (newest first), then the latest finished ones; children are left out. */
export function taskRows(tasks: BackgroundTask[], max = MAX_SHOWN): TaskRow[] {
  const top = tasks.filter((t) => !t.parentId)
  const open = top.filter((t) => OPEN.has(t.phase))
  const ended = top.filter((t) => !OPEN.has(t.phase))
  return [...open, ...ended].slice(0, max).map(taskRow)
}
