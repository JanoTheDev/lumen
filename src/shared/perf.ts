// Latency dev overlay (10 T11b): the last turn's stage timings against their budgets, for
// Settings → Diagnostics (`perf:last-turn`). Budgets come from the latency table in the plans
// (hotkey-up → transcript ≤ 400 ms, transcript → first model token ≤ 900 ms); the whole-turn
// budget is a default of ours, larger for guide / action turns (they also act on screen).

export interface PerfStage {
  name: string
  ms: number
  budgetMs: number
}

export interface PerfLastTurn {
  stages: PerfStage[]
  /** When the turn ended (epoch ms). */
  at: number
  mode: string
  outcome: 'done' | 'failed' | 'cancelled'
}

/** The timings a finished turn carries (a subset of main's TurnRecord). */
export interface TurnTimings {
  mode: string
  outcome: PerfLastTurn['outcome']
  speechToQueryMs?: number
  firstByteMs?: number
  totalMs: number
}

export const STAGE_BUDGETS_MS = {
  speechToText: 400,
  firstByte: 900,
  total: 3000,
  /** guide and action turns also resolve targets and act. */
  totalWithSteps: 6000
} as const

const STEP_MODES = new Set(['guide', 'action'])

export function totalBudgetMs(mode: string): number {
  return STEP_MODES.has(mode) ? STAGE_BUDGETS_MS.totalWithSteps : STAGE_BUDGETS_MS.total
}

/** Stage bars for one turn: only the stages it measured (a typed query has no speech stage). */
export function turnStages(t: TurnTimings): PerfStage[] {
  const stages: PerfStage[] = []
  if (t.speechToQueryMs !== undefined)
    stages.push({
      name: 'Speech to text',
      ms: t.speechToQueryMs,
      budgetMs: STAGE_BUDGETS_MS.speechToText
    })
  if (t.firstByteMs !== undefined)
    stages.push({ name: 'First reply', ms: t.firstByteMs, budgetMs: STAGE_BUDGETS_MS.firstByte })
  stages.push({
    name: 'Whole turn',
    ms: (t.speechToQueryMs ?? 0) + t.totalMs,
    budgetMs: totalBudgetMs(t.mode)
  })
  return stages
}

export function toPerfTurn(t: TurnTimings, at: number): PerfLastTurn {
  return { stages: turnStages(t), at, mode: t.mode, outcome: t.outcome }
}
