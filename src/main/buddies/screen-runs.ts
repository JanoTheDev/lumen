// A buddy's on-screen runs (08 T52): the foreground agent task is not a background task, so its
// run goes into a small record of its own (`~/.ai-overlay/buddies-screen-runs.json`, newest 20
// per buddy) that the buddy's history and list rows merge with its background runs. The task id
// is the foreground task's, so the history opens its task chat. A run still open at load was cut
// off by a quit: it reads as interrupted.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { BuddyRunSummary } from '@shared/buddies'

export interface ScreenRun extends BuddyRunSummary {
  buddyId: string
}

export interface ScreenRunEnd {
  phase: 'done' | 'failed' | 'cancelled' | 'paused'
  summary?: string
  costUsd?: number
  endedAt: number
}

const KEEP_PER_BUDDY = 20
const SUMMARY_MAX = 300
const PHASES = new Set(['running', 'paused', 'done', 'failed', 'cancelled', 'interrupted'])

function valid(x: unknown): x is ScreenRun {
  const r = x as Partial<ScreenRun> | null
  return (
    !!r &&
    typeof r.buddyId === 'string' &&
    typeof r.taskId === 'string' &&
    typeof r.title === 'string' &&
    typeof r.phase === 'string' &&
    PHASES.has(r.phase) &&
    typeof r.startedAt === 'number' &&
    typeof r.costUsd === 'number'
  )
}

export class ScreenRuns {
  private rows: ScreenRun[] | null = null

  /** `file`: null keeps the record in memory only. */
  constructor(private readonly file: string | null) {}

  private load(): ScreenRun[] {
    if (this.rows) return this.rows
    let rows: ScreenRun[] = []
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        rows = Array.isArray(raw) ? raw.filter(valid) : []
      } catch {
        rows = []
      }
    }
    // Open at load = Lumen quit while it ran.
    this.rows = rows.map((r) =>
      r.phase === 'running' || r.phase === 'paused' ? { ...r, phase: 'interrupted' } : r
    )
    return this.rows
  }

  private save(): void {
    if (!this.file || !this.rows) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.rows, null, 1), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // The record is a convenience; the run itself already happened.
    }
  }

  start(buddyId: string, taskId: string, title: string, at: number): void {
    const rows = this.load().filter((r) => r.taskId !== taskId)
    rows.push({ buddyId, taskId, title, phase: 'running', startedAt: at, costUsd: 0 })
    const mine = rows.filter((r) => r.buddyId === buddyId).sort((a, b) => b.startedAt - a.startedAt)
    const drop = new Set(mine.slice(KEEP_PER_BUDDY).map((r) => r.taskId))
    this.rows = rows.filter((r) => !drop.has(r.taskId))
    this.save()
  }

  end(taskId: string, e: ScreenRunEnd): void {
    const r = this.load().find((x) => x.taskId === taskId)
    if (!r) return
    r.phase = e.phase
    r.endedAt = e.endedAt
    if (e.summary) r.summary = e.summary.slice(0, SUMMARY_MAX)
    if (e.costUsd !== undefined) r.costUsd = e.costUsd
    this.save()
  }

  /** The buddy's on-screen runs, newest first. */
  list(buddyId: string): BuddyRunSummary[] {
    return this.load()
      .filter((r) => r.buddyId === buddyId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => {
        const row: Partial<ScreenRun> = { ...r }
        delete row.buddyId
        return row as BuddyRunSummary
      })
  }
}
