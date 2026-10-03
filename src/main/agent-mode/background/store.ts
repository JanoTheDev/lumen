// Background task persistence (08 T30): ~/.ai-overlay/tasks/<id>.json, one file per task,
// results only (never screenshots), written atomically (temp file + rename) so a crash
// mid-write cannot lose a finished result. Unreadable files are skipped. Progress of an open
// task is written at most every SAVE_DELAY_MS (`saveSoon`); an ended task at once.
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { BackgroundTask } from '@shared/types'
import { AtomicFiles } from '../atomic-file'

export const SAVE_DELAY_MS = 500

const ID_RE = /^bg_[a-z0-9]{4,40}$/
const PHASES = new Set([
  'queued',
  'running',
  'needs-foreground',
  'asking',
  'done',
  'failed',
  'cancelled',
  'interrupted'
])
const OPEN = new Set(['queued', 'running', 'needs-foreground', 'asking'])

export function parseTask(raw: unknown): BackgroundTask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<BackgroundTask>
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) return null
  if (typeof t.title !== 'string' || typeof t.prompt !== 'string') return null
  if (typeof t.phase !== 'string' || !PHASES.has(t.phase)) return null
  if (!t.counters || typeof t.counters.startedAt !== 'number') return null
  if (
    t.origin !== 'voice' &&
    t.origin !== 'agent' &&
    t.origin !== 'routine' &&
    t.origin !== 'buddy'
  )
    return null
  if (t.buddyId !== undefined && typeof t.buddyId !== 'string') delete t.buddyId
  if (t.userText !== undefined && typeof t.userText !== 'string') delete t.userText
  return {
    ...(t as BackgroundTask),
    progress: Array.isArray(t.progress) ? t.progress.filter((p) => typeof p === 'string') : []
  }
}

export class TaskStore {
  private readonly files = new AtomicFiles()
  private readonly pending = new Map<string, { task: BackgroundTask; timer: NodeJS.Timeout }>()

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  save(task: BackgroundTask): void {
    if (!ID_RE.test(task.id)) return
    this.drop(task.id)
    try {
      this.files.writeSync(this.file(task.id), JSON.stringify(task, null, 1))
    } catch (e) {
      console.warn('[tasks] save failed:', (e as Error).message)
    }
  }

  /** An open task's newest state, written a moment later; an ended task now. */
  saveSoon(task: BackgroundTask): void {
    if (!ID_RE.test(task.id)) return
    if (!OPEN.has(task.phase)) return this.save(task)
    const p = this.pending.get(task.id)
    if (p) {
      p.task = task
      return
    }
    const timer = setTimeout(() => {
      const q = this.pending.get(task.id)
      this.pending.delete(task.id)
      if (!q) return
      this.files
        .write(this.file(q.task.id), JSON.stringify(q.task, null, 1))
        .catch((e) => console.warn('[tasks] save failed:', (e as Error).message))
    }, SAVE_DELAY_MS)
    timer.unref?.()
    this.pending.set(task.id, { task, timer })
  }

  /** Writes every waiting save now (quit). */
  flushAll(): void {
    for (const { task } of [...this.pending.values()]) this.save(task)
  }

  private drop(id: string): void {
    const p = this.pending.get(id)
    if (p) clearTimeout(p.timer)
    this.pending.delete(id)
  }

  remove(id: string): void {
    if (!ID_RE.test(id)) return
    this.drop(id)
    this.files.forget(this.file(id))
    try {
      rmSync(this.file(id), { force: true })
    } catch {
      /* gone already */
    }
  }

  load(): BackgroundTask[] {
    this.flushAll()
    if (!existsSync(this.dir)) return []
    const out: BackgroundTask[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const t = parseTask(JSON.parse(readFileSync(join(this.dir, f), 'utf8')))
        if (t && `${t.id}.json` === f) out.push(t)
      } catch {
        /* unreadable: skipped */
      }
    }
    return out
  }
}
