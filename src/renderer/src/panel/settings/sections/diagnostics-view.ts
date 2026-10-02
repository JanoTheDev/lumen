// Settings → Diagnostics (10 T11b): pure view of the last turn's stage bars.
import type { PerfLastTurn, PerfStage } from '@shared/perf'

export interface StageBar {
  name: string
  /** Bar fill, 0..1 of the budget (full once over). */
  fill: number
  over: boolean
  /** Visible and spoken value, e.g. "1,240 ms of 900 ms, 340 ms over". */
  text: string
}

const ms = (n: number): string => `${Math.round(n).toLocaleString('en-US')} ms`

export function stageBar(s: PerfStage): StageBar {
  const over = s.ms > s.budgetMs
  const fill = s.budgetMs > 0 ? Math.min(1, Math.max(0, s.ms / s.budgetMs)) : 1
  const text = over
    ? `${ms(s.ms)} of ${ms(s.budgetMs)}, ${ms(s.ms - s.budgetMs)} over`
    : `${ms(s.ms)} of ${ms(s.budgetMs)}`
  return { name: s.name, fill, over, text }
}

const OUTCOME: Record<PerfLastTurn['outcome'], string> = {
  done: 'finished',
  failed: 'failed',
  cancelled: 'was cancelled'
}

/** "Last turn (answer) finished at 14:05:09 · 1 of 3 stages over budget". */
export function turnSummary(t: PerfLastTurn, time: (at: number) => string): string {
  const over = t.stages.filter((s) => s.ms > s.budgetMs).length
  const n = t.stages.length
  const head = `Last turn (${t.mode}) ${OUTCOME[t.outcome]} at ${time(t.at)}`
  return over
    ? `${head} · ${over} of ${n} ${n === 1 ? 'stage' : 'stages'} over budget`
    : `${head} · all within budget`
}
