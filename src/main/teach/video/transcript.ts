// The markdown transcript beside a lesson video (07 T30): each step's say line, when it
// started (relative to the start of the video) and how it ended: passed, failed (left without
// passing) or skipped. Pure.
import { localDate } from './naming'

export type StepOutcome = 'pass' | 'fail' | 'skip'

export interface TranscriptRow {
  /** 0-based step index in the lesson. */
  index: number
  say: string
  /** Milliseconds since the video started. */
  at: number
  outcome?: StepOutcome
  /** Tries that did not pass before this outcome. */
  misses?: number
  /** Lumen did the step ("do it for me"). */
  doneForYou?: boolean
}

/** How a step that ended without passing went, read from the lesson's step stats. */
export interface StepEnd {
  skipped?: boolean
  attempts?: number
  doItForMe?: boolean
}

export class LessonTranscript {
  readonly rows: TranscriptRow[] = []
  private ended: { at: number; completed: boolean | null } | null = null

  constructor(
    readonly title: string,
    readonly app: string,
    readonly startedAt: Date,
    private readonly startMs: number
  ) {}

  private rel(now: number): number {
    return Math.max(0, now - this.startMs)
  }

  /** The step on screen (not ended yet), else null. */
  openIndex(): number | null {
    return this.open()?.index ?? null
  }

  private open(): TranscriptRow | undefined {
    const last = this.rows[this.rows.length - 1]
    return last && !last.outcome ? last : undefined
  }

  /** Closes the open row without a pass: skipped when the stats say so, else failed. */
  private closeOpen(end?: StepEnd): void {
    const row = this.open()
    if (!row) return
    row.outcome = end?.skipped ? 'skip' : 'fail'
    if (end?.attempts) row.misses = end.attempts
    if (end?.doItForMe) row.doneForYou = true
  }

  /** A step came up (also going back to an earlier one). `prev`: how the open one ended. */
  stepStarted(index: number, say: string, now: number, prev?: StepEnd): void {
    // The same step shown again (resumed after a pause) keeps its row.
    if (this.ended || this.open()?.index === index) return
    this.closeOpen(prev)
    this.rows.push({ index, say, at: this.rel(now) })
  }

  /** The open step passed. */
  stepPassed(index: number, end?: StepEnd): void {
    const row = this.open()
    if (!row || row.index !== index) return
    row.outcome = 'pass'
    if (end?.attempts) row.misses = end.attempts
    if (end?.doItForMe) row.doneForYou = true
  }

  /** The video ended: `completed` true / false when the lesson ended, null when only the video did. */
  end(now: number, completed: boolean | null, last?: StepEnd): void {
    if (this.ended) return
    if (completed !== null) this.closeOpen(last)
    this.ended = { at: this.rel(now), completed }
  }

  render(): string {
    const lines = [
      `# ${oneLine(this.title)}`,
      '',
      `Lesson recording, ${this.app ? `${oneLine(this.app)}, ` : ''}${stamp(this.startedAt)}.`,
      ''
    ]
    if (!this.rows.length) lines.push('No steps were shown while recording.', '')
    for (const r of this.rows) {
      const how = r.outcome ? OUTCOME[r.outcome] : 'still on this step when the recording ended'
      const extra = [
        r.misses ? `${r.misses} ${r.misses === 1 ? 'try' : 'tries'} before` : '',
        r.doneForYou ? 'done by Lumen' : ''
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(
        `- **${clock(r.at)}** Step ${r.index + 1}: ${oneLine(r.say)} — ${how}${extra ? ` (${extra})` : ''}`
      )
    }
    if (this.ended) {
      const why =
        this.ended.completed === true
          ? 'Lesson finished'
          : this.ended.completed === false
            ? 'Lesson stopped'
            : 'Recording stopped'
      lines.push('', `${why} at ${clock(this.ended.at)}.`)
    }
    const counts = (['pass', 'fail', 'skip'] as const).map(
      (o) => this.rows.filter((r) => r.outcome === o).length
    )
    lines.push('', `Passed ${counts[0]}, not passed ${counts[1]}, skipped ${counts[2]}.`, '')
    return lines.join('\n')
  }
}

const OUTCOME: Record<StepOutcome, string> = {
  pass: 'passed',
  fail: 'not passed',
  skip: 'skipped'
}

/** 75_000 → "01:15", 3_725_000 → "1:02:05". */
export function clock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** One markdown line: no line breaks, no leading heading / list marks. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400)
}
