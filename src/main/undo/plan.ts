// "Undo that" (11 T16), pure: the undo stack, which records can be reversed from where the
// user is now, the actions that reverse them, and the honest report of what was not undone.
import type { Action } from '@shared/types'
import type { Reversal, UndoRecord } from './records'

export const UNDO_MAX = 50
/** Older records are dropped: an hour later the screen has moved on. */
export const UNDO_TTL_MS = 60 * 60_000

export class UndoStack {
  private list: UndoRecord[] = []

  constructor(
    private readonly max = UNDO_MAX,
    private readonly ttlMs = UNDO_TTL_MS
  ) {}

  add(rec: UndoRecord): void {
    this.list.push(rec)
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max)
  }

  /** Up to `n` records, newest first, skipping no-ops (they need no undo and no mention). */
  take(n: number, now: number): UndoRecord[] {
    const live = this.list.filter((r) => now - r.at <= this.ttlMs)
    const out: UndoRecord[] = []
    for (let i = live.length - 1; i >= 0 && out.length < n; i--) {
      if (live[i].reversal?.kind !== 'noop') out.push(live[i])
    }
    return out
  }

  /** Records of the newest task, newest first ("undo what you just did"). */
  lastTask(now: number): UndoRecord[] {
    const live = this.list.filter((r) => now - r.at <= this.ttlMs && r.reversal?.kind !== 'noop')
    const task = live[live.length - 1]?.taskId
    return task ? live.filter((r) => r.taskId === task).reverse() : []
  }

  remove(ids: Set<string>): void {
    this.list = this.list.filter((r) => !ids.has(r.id))
  }

  /** When Lumen last acted (any record), or null. */
  lastAt(): number | null {
    return this.list.length ? this.list[this.list.length - 1].at : null
  }

  get size(): number {
    return this.list.length
  }

  clear(): void {
    this.list = []
  }
}

export interface Where {
  /** Process name of the window in front, lower case. */
  process?: string
  isBrowser?: boolean
}

export interface PlannedUndo {
  record: UndoRecord
  /** Actions for the executor; empty for file restores (done directly). */
  actions: Action[]
}

export interface UndoPlan {
  run: PlannedUndo[]
  skipped: { record: UndoRecord; why: string }[]
}

export function reversalActions(r: Reversal, label: string): Action[] {
  switch (r.kind) {
    case 'keys':
      return [
        {
          type: 'input',
          steps: Array.from({ length: Math.max(1, Math.min(r.count, 20)) }, () => ({
            t: 'keys' as const,
            combo: r.combo
          }))
        }
      ]
    case 'set-value':
      return [
        {
          type: 'uia_act',
          elementId: r.elementId,
          action: 'set_value',
          value: r.value,
          description: label
        }
      ]
    case 'uia':
      return [{ type: 'uia_act', elementId: r.elementId, action: r.action, description: label }]
    case 'scroll':
      return [{ type: 'scroll', direction: r.direction, amount: r.amount }]
    case 'restore-file':
    case 'noop':
      return []
  }
}

/**
 * Which records can be reversed from here. Key reversals only run in the window they were
 * done in (Ctrl+Z in the wrong app would undo the user's own work), and the plan stops at the
 * first record it cannot reverse: undoing later steps around an earlier one could leave things
 * half-done, so everything older is reported as not undone.
 */
export function planUndo(records: UndoRecord[], where: Where): UndoPlan {
  const plan: UndoPlan = { run: [], skipped: [] }
  let blocked: string | null = null
  for (const record of records) {
    if (blocked) {
      plan.skipped.push({ record, why: blocked })
      continue
    }
    const r = record.reversal
    if (!r) {
      plan.skipped.push({ record, why: record.irreversible ?? 'it can’t be undone' })
      blocked = 'it came before a step I couldn’t undo'
      continue
    }
    if (r.kind === 'keys' || r.kind === 'scroll') {
      if (record.needsBrowser && where.isBrowser === false) {
        plan.skipped.push({ record, why: 'the browser isn’t in front any more' })
        blocked = 'it came before a step I couldn’t undo'
        continue
      }
      if (record.process && where.process && record.process !== where.process) {
        const app = record.title ? `“${record.title.slice(0, 40)}”` : record.process
        plan.skipped.push({
          record,
          why: `it was in ${app}; switch back to it and say “undo that” again`
        })
        blocked = 'it came before a step I couldn’t undo'
        continue
      }
    }
    plan.run.push({ record, actions: reversalActions(r, record.what) })
  }
  return plan
}

const list = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** What was undone and, honestly, what was not and why. */
export function undoReport(
  done: UndoRecord[],
  failed: { record: UndoRecord; why: string }[]
): string {
  const parts: string[] = []
  if (done.length) {
    const approx = done.some((r) => r.approximate)
    parts.push(
      `Undone: ${list(done.map((r) => r.what))}.${approx ? ' I used the app’s own undo, so check it looks right.' : ''}`
    )
  }
  for (const f of failed) parts.push(`Not undone: ${f.record.what}, because ${f.why}.`)
  if (!parts.length) return 'There is nothing of mine to undo.'
  return parts.join(' ')
}
