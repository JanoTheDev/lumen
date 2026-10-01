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
}

const OPEN = new Set(['queued', 'running', 'asking', 'needs-foreground'])

function cost(usd: number): string {
  return usd >= 0.01 ? ` · $${usd.toFixed(2)}` : ''
}

export function taskRow(t: BackgroundTask): TaskRow {
  const last = t.progress[t.progress.length - 1]
  let status: string
  switch (t.phase) {
    case 'queued':
      status = 'Waiting to start'
      break
    case 'running':
      status = last ?? 'Working…'
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
  const open = OPEN.has(t.phase)
  return {
    id: t.id,
    title: t.title,
    status: `${status}${t.phase === 'running' ? cost(t.counters.costUsd) : ''}`,
    phase: t.phase,
    canCancel: open,
    canRunAgain: t.phase === 'interrupted' || t.phase === 'failed' || t.phase === 'cancelled',
    canOpen: !!t.result || t.phase === 'running',
    ...(t.question && (t.phase === 'asking' || t.phase === 'needs-foreground')
      ? { question: { text: t.question.text, choices: t.question.choices ?? [] } }
      : {}),
    unseen: !!t.unseen
  }
}

/** Open tasks first (newest first), then the latest finished ones; children are left out. */
export function taskRows(tasks: BackgroundTask[], max = MAX_SHOWN): TaskRow[] {
  const top = tasks.filter((t) => !t.parentId)
  const open = top.filter((t) => OPEN.has(t.phase))
  const ended = top.filter((t) => !OPEN.has(t.phase))
  return [...open, ...ended].slice(0, max).map(taskRow)
}
