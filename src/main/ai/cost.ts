// Cost tracking: every model call adds to the current turn (router + main + verify + refine)
// and to the session and day totals.
import { AsyncLocalStorage } from 'async_hooks'
import { EMPTY_USAGE, type Usage } from './providers/types'
import { formatUsage, roundUsd as round, usageCost } from './pricing'

export interface TurnCost {
  usd: number
  calls: number
  usage: Usage
  /** Model that produced the user-facing answer. */
  model?: string
}

const turns = new AsyncLocalStorage<TurnCost>()
let sessionUsd = 0
let day = { key: '', usd: 0 }

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

/** Records one call's usage: logs it, adds it to the current turn and the running totals. */
export function recordUsage(model: string, usage: Usage, hasImage = false, now = new Date()): void {
  console.log(formatUsage(model, usage, hasImage))
  const cost = usageCost(model, usage).total
  sessionUsd = round(sessionUsd + cost)
  const key = dayKey(now)
  day = { key, usd: round((day.key === key ? day.usd : 0) + cost) }
  const turn = turns.getStore()
  if (!turn) return
  turn.usd = round(turn.usd + cost)
  turn.calls++
  turn.usage = {
    inputTokens: turn.usage.inputTokens + usage.inputTokens,
    outputTokens: turn.usage.outputTokens + usage.outputTokens,
    cacheReadTokens: turn.usage.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: turn.usage.cacheWriteTokens + usage.cacheWriteTokens
  }
}

/** Marks the model that answered the current turn. */
export function noteAnswerModel(model: string): void {
  const turn = turns.getStore()
  if (turn) turn.model = model
}

export function costTotals(): { sessionUsd: number; dayUsd: number } {
  return { sessionUsd, dayUsd: day.key === dayKey(new Date()) ? day.usd : 0 }
}

/** Runs one user turn with its own cost accumulator; `onDone` gets the total even on failure. */
export async function withTurnCost<T>(
  fn: () => Promise<T>,
  onDone?: (cost: TurnCost) => void
): Promise<T> {
  const turn: TurnCost = { usd: 0, calls: 0, usage: { ...EMPTY_USAGE } }
  try {
    return await turns.run(turn, fn)
  } finally {
    const { sessionUsd: session, dayUsd } = costTotals()
    console.log(
      `[cost] turn $${turn.usd.toFixed(4)} (${turn.calls} calls) | session $${session.toFixed(4)} | today $${dayUsd.toFixed(4)}`
    )
    onDone?.(turn)
  }
}

/** Test hook. */
export function resetCostTotals(): void {
  sessionUsd = 0
  day = { key: '', usd: 0 }
}
