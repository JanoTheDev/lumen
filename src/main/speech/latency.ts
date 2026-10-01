// Voice latency marks for one spoken turn, measured from the end of speech (hotkey released or
// silence detected): stt-final, first-token, tts-first-audio. Barge-in is not marked here: the
// renderer stops playback synchronously once its 250 ms detector fires, so the latency that
// matters is acoustic and needs a recording. Each mark is logged as `[time] voice <mark>` (main.log, for a perf harness that reads
// logs) and kept in memory; voiceLatencyReport() gives p50/p95 over the last turns.
import { bus } from '../bus'
import { log } from '../logger'

export type VoiceMark = 'stt-final' | 'first-token' | 'tts-first-audio'

const KEEP = 50

interface Turn {
  speechEnd: number
  marks: Partial<Record<VoiceMark, number>>
  turnId?: string
}

export class VoiceLatency {
  private turn: Turn | null = null
  private readonly history: Array<Partial<Record<VoiceMark, number>>> = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly out: (mark: string, ms: number) => void = (mark, ms) =>
      log('time', `voice ${mark}`, { timeMs: ms })
  ) {}

  /** End of speech: hotkey released, or the renderer heard silence. Starts a turn. */
  speechEnded(): void {
    this.finish()
    this.turn = { speechEnd: this.now(), marks: {} }
    this.out('hotkey-up', 0)
  }

  /** The query turn that this speech started (first query.started after the speech). */
  turnStarted(turnId: string): void {
    if (this.turn && !this.turn.turnId) this.turn.turnId = turnId
  }

  mark(name: VoiceMark, turnId?: string): void {
    const t = this.turn
    if (!t || t.marks[name] !== undefined) return
    if (turnId && t.turnId && turnId !== t.turnId) return
    const ms = this.now() - t.speechEnd
    t.marks[name] = ms
    this.out(name, ms)
  }

  private finish(): void {
    if (this.turn && Object.keys(this.turn.marks).length) {
      this.history.push(this.turn.marks)
      if (this.history.length > KEEP) this.history.shift()
    }
    this.turn = null
  }

  /** p50 / p95 in ms per mark over the finished turns (and the current one). */
  report(): Record<VoiceMark, { n: number; p50: number; p95: number } | null> {
    const all = [...this.history, ...(this.turn ? [this.turn.marks] : [])]
    const names: VoiceMark[] = ['stt-final', 'first-token', 'tts-first-audio']
    const out = {} as Record<VoiceMark, { n: number; p50: number; p95: number } | null>
    for (const name of names) {
      const values = all
        .map((m) => m[name])
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b)
      out[name] = values.length
        ? { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
        : null
    }
    return out
  }
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

export const voiceLatency = new VoiceLatency()

export function voiceLatencyReport(): ReturnType<VoiceLatency['report']> {
  return voiceLatency.report()
}

bus.on('query.started', ({ turnId }) => voiceLatency.turnStarted(turnId))
bus.on('query.delta', ({ turnId }) => voiceLatency.mark('first-token', turnId))
