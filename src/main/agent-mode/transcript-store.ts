// Task transcripts on disk (08 T43): ~/.ai-overlay/tasks/transcripts/<id>.json next to the task
// files, one per background task (bg_), foreground agent task (t_) and Claude session (cc_).
// Written atomically (temp file + rename); unreadable files are skipped. Background
// transcripts go with their task; foreground and Claude ones keep the newest KEEP_OTHER.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { chatIdSchema, type ChatEntry, type JobStep, type SubJob } from '@shared/task-chat'
import { MAX_JOB_STEPS, type ChatMeta, type TranscriptData } from './transcript'

export const KEEP_OTHER = 30

const KINDS = new Set(['user', 'assistant', 'tool', 'question', 'status', 'error', 'result'])

const validId = (id: string): boolean => chatIdSchema.safeParse(id).success

const STEP_STATUS = new Set(['running', 'ok', 'error', 'denied'])

const isStep = (st: unknown): st is JobStep =>
  !!st &&
  typeof st === 'object' &&
  typeof (st as JobStep).n === 'number' &&
  typeof (st as JobStep).label === 'string' &&
  STEP_STATUS.has((st as JobStep).status)

/** A job's saved steps: well-formed ones only, the newest MAX_JOB_STEPS. */
function cleanJob(j: SubJob): SubJob {
  if (j.steps === undefined) return j
  const ok = Array.isArray(j.steps) ? j.steps.filter(isStep) : []
  const steps = ok.slice(-MAX_JOB_STEPS)
  const dropped =
    (typeof j.stepsDropped === 'number' ? j.stepsDropped : 0) + ok.length - steps.length
  const rest: SubJob = { ...j }
  delete rest.steps
  delete rest.stepsDropped
  return {
    ...rest,
    ...(steps.length ? { steps } : {}),
    ...(dropped ? { stepsDropped: dropped } : {})
  }
}

function cleanEntry(e: ChatEntry): ChatEntry {
  if (e.k !== 'tool' || e.jobs === undefined) return e
  if (!Array.isArray(e.jobs)) {
    const rest = { ...e }
    delete rest.jobs
    return rest
  }
  return { ...e, jobs: e.jobs.filter((j) => !!j && typeof j === 'object').map(cleanJob) }
}

export function parseTranscript(raw: unknown, id: string): TranscriptData | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<TranscriptData>
  if (t.id !== id || !Array.isArray(t.entries)) return null
  const entries = t.entries
    .filter(
      (e): e is ChatEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as ChatEntry).n === 'number' &&
        typeof (e as ChatEntry).at === 'number' &&
        KINDS.has((e as ChatEntry).k)
    )
    .map(cleanEntry)
  const meta = t.meta && typeof t.meta === 'object' ? (t.meta as ChatMeta) : undefined
  return {
    id,
    entries,
    dropped: typeof t.dropped === 'number' ? t.dropped : 0,
    ...(meta && typeof meta.title === 'string' && typeof meta.startedAt === 'number'
      ? { meta }
      : {})
  }
}

export class TranscriptStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  load(id: string): TranscriptData | null {
    if (!validId(id)) return null
    try {
      return parseTranscript(JSON.parse(readFileSync(this.file(id), 'utf8')), id)
    } catch {
      return null
    }
  }

  save(data: TranscriptData): void {
    if (!validId(data.id)) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.file(data.id)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data), 'utf8')
      renameSync(tmp, file)
    } catch (e) {
      console.warn('[transcripts] save failed:', (e as Error).message)
    }
  }

  remove(id: string): void {
    if (!validId(id)) return
    try {
      rmSync(this.file(id), { force: true })
    } catch {
      /* gone already */
    }
  }

  ids(): string[] {
    if (!existsSync(this.dir)) return []
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter(validId)
    } catch {
      return []
    }
  }

  /**
   * Background transcripts whose task is gone are removed (`tasks` null: background ones stay);
   * foreground and Claude transcripts beyond the newest `keepOther` too. Returns the ids kept.
   */
  prune(tasks: ReadonlySet<string> | null, keepOther = KEEP_OTHER): string[] {
    const other: { id: string; t: number }[] = []
    const kept: string[] = []
    for (const id of this.ids()) {
      if (id.startsWith('bg_')) {
        if (!tasks || tasks.has(id)) kept.push(id)
        else this.remove(id)
        continue
      }
      let t = 0
      try {
        t = statSync(this.file(id)).mtimeMs
      } catch {
        /* keep order */
      }
      other.push({ id, t })
    }
    other.sort((a, b) => b.t - a.t)
    other.slice(keepOther).forEach((o) => this.remove(o.id))
    return [...kept, ...other.slice(0, keepOther).map((o) => o.id)]
  }
}
