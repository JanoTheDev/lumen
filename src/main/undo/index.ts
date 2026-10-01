// "Undo what you just did" wired to the app (11 T16). The executor calls recordUndo() before
// each action and commits the record once the action ran; "undo that" plans the reversals from
// the window in front, runs them through the executor (policy, audit, cancel) as one batch in
// the input lane (the user's own input: it never waits, and never interleaves with an agent
// batch) and says what could not be undone. File tools prepare a file record (a copy) before
// they change a file and commit it once the change succeeded; a rename or move is one record.
import { homedir } from 'os'
import { join } from 'path'
import type { Action } from '@shared/types'
import { loadConfig } from '../config'
import { log } from '../logger'
import type { ActiveWindowInfo } from '../agent/commands'
import { getAgent } from '../agent/instance'
import { withInputLane } from '../agent-mode/input-lane'
import { elementIndex } from '../query/uia-list'
import { currentContext } from '../query/context'
import { UndoTrash } from './files'
import { planUndo, undoReport, UndoStack, type PlannedUndo } from './plan'
import { fileRecord, moveRecord, reversalFor, type UndoRecord } from './records'

const FOREGROUND_TIMEOUT_MS = 800
/** "undo that" means Lumen's last action only this soon after it; later it is the app's Ctrl+Z. */
export const UNDO_THAT_MS = 2 * 60_000

const stack = new UndoStack()
let trash: UndoTrash | null = null
/** True while an undo runs: its own actions are not recorded. */
let undoing = false
let seq = 0

const nextId = (): string => `u${Date.now().toString(36)}${(seq++).toString(36)}`

export function undoEnabled(): boolean {
  return loadConfig().helpers.undo
}

export function installUndo(dir = join(homedir(), '.ai-overlay', 'undo-trash')): void {
  trash = new UndoTrash(dir)
  try {
    trash.prune()
  } catch (e) {
    log('fail', `undo trash prune failed: ${(e as Error).message}`)
  }
}

async function foreground(): Promise<ActiveWindowInfo | null> {
  const agent = getAgent()
  if (!agent) return null
  return agent
    .request<ActiveWindowInfo>('active_window', {}, { timeoutMs: FOREGROUND_TIMEOUT_MS })
    .catch(() => null)
}

function oldValueOf(action: Action): string | undefined {
  if (action.type !== 'uia_act' || action.action !== 'set_value') return undefined
  const el = elementIndex(currentContext()?.uia).get(action.elementId)
  return el?.value
}

/**
 * Called by the executor before an action runs. Returns the commit to call once it ran (ok),
 * or null when undo is off. Never throws.
 */
export async function recordUndo(
  action: Action,
  ctx: { taskId: string }
): Promise<(() => void) | null> {
  if (undoing || !undoEnabled()) return null
  try {
    const w = action.type === 'move' ? null : await foreground()
    const rec = reversalFor(action, {
      id: nextId(),
      at: Date.now(),
      taskId: ctx.taskId,
      process: w?.process || w?.exe,
      title: w?.title,
      oldValue: oldValueOf(action)
    })
    return () => stack.add({ ...rec, at: Date.now() })
  } catch (e) {
    log('fail', `undo record failed: ${(e as Error).message}`)
    return null
  }
}

export interface PreparedFileUndo {
  /** The change succeeded: the record joins the undo stack. */
  commit(): void
  /** The change did not happen: the kept copy is dropped, nothing is recorded. */
  discard(): void
}

const NOTHING: PreparedFileUndo = { commit: () => {}, discard: () => {} }

/**
 * For file tools: keep a copy of `path` before changing or deleting it (or note that it is
 * new). The record is added only on commit(), once the change succeeded. Returns null when no
 * copy could be kept: the caller should leave the file alone.
 */
export function prepareFileUndo(
  path: string,
  verb: 'changed' | 'deleted' | 'created' | 'moved',
  taskId: string
): PreparedFileUndo | null {
  const t = trash
  if (!undoEnabled() || !t) return NOTHING
  const id = nextId()
  try {
    const backup = verb === 'created' ? null : t.backup(path, id)
    return {
      commit: () => stack.add(fileRecord({ id, at: Date.now(), taskId }, path, backup, verb)),
      discard: () => {
        if (backup) t.drop(id)
      }
    }
  } catch (e) {
    log('fail', `undo copy of a file failed: ${(e as Error).message}`)
    return null
  }
}

/** prepareFileUndo, committed at once. False when no copy could be kept. */
export function keepFileForUndo(
  path: string,
  verb: 'changed' | 'deleted' | 'created' | 'moved',
  taskId: string
): boolean {
  const p = prepareFileUndo(path, verb, taskId)
  p?.commit()
  return !!p
}

/** After a rename or move succeeded: one record whose undo moves the file back. */
export function recordFileMove(from: string, to: string, taskId: string): void {
  if (!undoEnabled() || !trash) return
  stack.add(moveRecord({ id: nextId(), at: Date.now(), taskId }, from, to))
}

/** Lumen acted within `ms` (and undo is on): "undo that" is about Lumen's action. */
export function recentlyActed(ms = UNDO_THAT_MS, now = Date.now()): boolean {
  const at = stack.lastAt()
  return undoEnabled() && at !== null && now - at <= ms
}

export interface UndoDeps {
  /** Runs reversal actions (executeActions); undoLast already holds the input lane around it. */
  run(actions: Action[]): Promise<{ executed: number; blocked: boolean; cancelled: boolean }>
}

async function runOne(p: PlannedUndo, deps: UndoDeps): Promise<string | null> {
  const r = p.record.reversal
  if (r?.kind === 'restore-file') {
    if (!trash) return 'the undo copies are not available'
    try {
      if (r.movedTo) trash.moveBack(r.path, r.movedTo)
      else trash.restore(r.path, r.backup, p.record.id)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }
  if (!p.actions.length) return null
  const res = await deps.run(p.actions)
  if (res.cancelled) return 'you stopped it'
  if (res.blocked) return 'the safety check stopped it'
  return res.executed ? null : 'the app did not take it'
}

/**
 * "undo that" (n = 1), "undo the last 3 things" (n = 3), "undo everything you just did"
 * (n = 'task'). Returns what to tell the user.
 */
export async function undoLast(n: number | 'task', deps: UndoDeps): Promise<string> {
  const now = Date.now()
  const records: UndoRecord[] = n === 'task' ? stack.lastTask(now) : stack.take(n, now)
  if (!records.length) return 'There is nothing of mine to undo.'
  const w = await foreground()
  const plan = planUndo(records, {
    process: (w?.process || w?.exe)?.toLowerCase(),
    isBrowser: w?.isBrowser
  })
  const done: UndoRecord[] = []
  const failed = [...plan.skipped]
  undoing = true
  try {
    await withInputLane(
      'undo',
      async () => {
        for (let i = 0; i < plan.run.length; i++) {
          const p = plan.run[i]
          const why = await runOne(p, deps)
          if (why) {
            const rest = plan.run.slice(i + 1).map((q) => ({
              record: q.record,
              why: 'it came before a step I couldn’t undo'
            }))
            failed.unshift({ record: p.record, why }, ...rest)
            break
          }
          done.push(p.record)
        }
      },
      { user: true }
    )
  } finally {
    undoing = false
  }
  stack.remove(new Set(done.map((r) => r.id)))
  log('step', `undo: ${done.length} reversed, ${failed.length} not`)
  return undoReport(done, failed)
}

/** Test hook. */
export function undoStack(): UndoStack {
  return stack
}
