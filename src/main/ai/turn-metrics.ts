// Per-turn latency and token record (the latency/cost baseline). Each finished turn logs one line,
// `[time] turn {json}`, into main.log; `npm run perf:baseline` reads those lines and prints
// p50/p95 per mode. Measured from bus events: end of speech (voice.stopped) -> query.started
// (the transcript arrived) -> first streamed byte of the spoken answer -> query.done.
// No prompt or answer text is logged, only its length.
import { bus } from '../bus'
import { log } from '../logger'

export interface TurnRecord {
  mode: string
  outcome: 'done' | 'failed' | 'cancelled'
  model?: string
  /** End of speech (hotkey up / silence) to the query: STT time. Absent for typed queries. */
  speechToQueryMs?: number
  /** Query to the first streamed piece of the spoken answer. */
  firstByteMs?: number
  totalMs: number
  promptChars: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  usd: number
}

/** A query that starts this long after the speech ended was typed or came from elsewhere. */
const SPEECH_LINK_MS = 30_000

interface Open {
  start: number
  promptChars: number
  speechToQueryMs?: number
  firstByteMs?: number
}

export class TurnMetrics {
  private speechEnd: number | null = null
  private readonly open = new Map<string, Open>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly out: (r: TurnRecord) => void = (r) =>
      log('time', `turn ${JSON.stringify(r)}`, { timeMs: r.totalMs })
  ) {}

  speechEnded(): void {
    this.speechEnd = this.now()
  }

  started(turnId: string, prompt: string): void {
    const t = this.now()
    const linked = this.speechEnd !== null && t - this.speechEnd <= SPEECH_LINK_MS
    this.open.set(turnId, {
      start: t,
      promptChars: prompt.length,
      ...(linked ? { speechToQueryMs: t - this.speechEnd! } : {})
    })
    // One speech end belongs to one query (parallel sub-turns and follow-ups are not spoken).
    if (linked) this.speechEnd = null
  }

  firstByte(turnId: string): void {
    const o = this.open.get(turnId)
    if (o && o.firstByteMs === undefined) o.firstByteMs = this.now() - o.start
  }

  finished(
    turnId: string,
    outcome: TurnRecord['outcome'],
    info: {
      mode?: string
      model?: string
      cost?: Partial<Omit<TurnRecord, 'mode' | 'outcome' | 'model'>> & { usd?: number }
    } = {}
  ): TurnRecord | null {
    const o = this.open.get(turnId)
    if (!o) return null
    this.open.delete(turnId)
    const c = info.cost ?? {}
    const record: TurnRecord = {
      mode: info.mode ?? 'unknown',
      outcome,
      ...(info.model ? { model: info.model } : {}),
      ...(o.speechToQueryMs !== undefined ? { speechToQueryMs: o.speechToQueryMs } : {}),
      ...(o.firstByteMs !== undefined ? { firstByteMs: o.firstByteMs } : {}),
      totalMs: this.now() - o.start,
      promptChars: o.promptChars,
      calls: c.calls ?? 0,
      inputTokens: c.inputTokens ?? 0,
      outputTokens: c.outputTokens ?? 0,
      cacheReadTokens: c.cacheReadTokens ?? 0,
      cacheWriteTokens: c.cacheWriteTokens ?? 0,
      usd: c.usd ?? 0
    }
    this.out(record)
    return record
  }
}

let installed = false

/** Subscribes the app-wide recorder to the bus (once). */
export function installTurnMetrics(metrics = new TurnMetrics()): void {
  if (installed) return
  installed = true
  bus.on('voice.stopped', () => metrics.speechEnded())
  bus.on('query.started', ({ turnId, prompt }) => metrics.started(turnId, prompt))
  bus.on('query.delta', ({ turnId }) => metrics.firstByte(turnId))
  bus.on('query.done', ({ turnId, response, model, cost }) =>
    metrics.finished(turnId, 'done', { mode: response.mode, model, cost })
  )
  bus.on('query.failed', ({ turnId }) => metrics.finished(turnId, 'failed'))
  bus.on('query.cancelled', ({ turnId }) => metrics.finished(turnId, 'cancelled'))
}
