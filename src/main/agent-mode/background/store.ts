// Background task persistence (08 T30): ~/.ai-overlay/tasks/<id>.json, one file per task,
// results only (never screenshots). Unreadable files are skipped.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BackgroundTask } from '@shared/types'

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

export function parseTask(raw: unknown): BackgroundTask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<BackgroundTask>
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) return null
  if (typeof t.title !== 'string' || typeof t.prompt !== 'string') return null
  if (typeof t.phase !== 'string' || !PHASES.has(t.phase)) return null
  if (!t.counters || typeof t.counters.startedAt !== 'number') return null
  if (t.origin !== 'voice' && t.origin !== 'agent' && t.origin !== 'routine') return null
  return {
    ...(t as BackgroundTask),
    progress: Array.isArray(t.progress) ? t.progress.filter((p) => typeof p === 'string') : []
  }
}

export class TaskStore {
  constructor(private readonly dir: string) {}

  save(task: BackgroundTask): void {
    if (!ID_RE.test(task.id)) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, `${task.id}.json`), JSON.stringify(task, null, 1), 'utf8')
    } catch (e) {
      console.warn('[tasks] save failed:', (e as Error).message)
    }
  }

  remove(id: string): void {
    if (!ID_RE.test(id)) return
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch {
      /* gone already */
    }
  }

  load(): BackgroundTask[] {
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
