// Cost tracking: every model call adds to the current turn (router + main + verify + refine)
// and to the session and day totals, and becomes one usage ledger line (usage/ledger) with the
// usage scope of the work that made it.
import { AsyncLocalStorage } from 'async_hooks'
import { EMPTY_USAGE, type Usage } from './providers/types'
import { formatUsage, isFreeModel, knownCost, rateFor, roundUsd as round } from './pricing'
import { usageSummary, type UsageSummary } from './usage-log'
import { recordCall, type UsageEntry } from '../usage/ledger'

export interface TurnCost {
  usd: number
  calls: number
  usage: Usage
  /** Model that produced the user-facing answer. */
  model?: string
}

const turns = new AsyncLocalStorage<TurnCost>()
let sessionUsd = 0
// Some call this session used a model without a known price.
let unpriced = false
let day = { key: '', usd: 0 }
// Calls after the first one: how many read the prompt cache, and the input token share read.
const cache = { calls: 0, hits: 0, input: 0, read: 0 }

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

/** What the call site knows beyond tokens. */
export interface CallMeta {
  /** Backend (anthropic, openai, …); guessed from the model id when left out. */
  provider?: string
  role?: string
  /** Paid web searches made in the call, with their fee in `extraUsd`. */
  searches?: number
  extraUsd?: number
  /** Ledger feature for this call, over the scope's (e.g. 'how-to'). */
  feature?: string
}

/** Backend from a model id, for call sites that do not pass one. */
export function guessProvider(model: string): string {
  if (/^claude-/.test(model)) return 'anthropic'
  if (/^(gpt-|o\d|whisper|tts-)/.test(model)) return 'openai'
  if (/^gemini/.test(model)) return 'gemini'
  return 'unknown'
}

function addToTotals(cost: number, usage: Usage, now: Date): void {
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

/**
 * Records one call's usage: logs it, adds it to the current turn and the running totals, and
 * writes its ledger line.
 */
export function recordUsage(
  model: string,
  usage: Usage,
  hasImage = false,
  now = new Date(),
  meta: CallMeta = {}
): void {
  console.log(formatUsage(model, usage, hasImage))
  if (cache.calls++ > 0) {
    cache.input += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    cache.read += usage.cacheReadTokens
    if (usage.cacheReadTokens > 0) cache.hits++
  }
  const known = rateFor(model).known
  if (!known) unpriced = true
  const cost = round(knownCost(model, usage).total + (meta.extraUsd ?? 0))
  addToTotals(cost, usage, now)
  recordCall({
    t: now.getTime(),
    provider: meta.provider ?? guessProvider(model),
    model,
    ...(meta.role ? { role: meta.role } : {}),
    in: usage.inputTokens,
    out: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    searches: meta.searches ?? 0,
    usd: cost,
    priced: known,
    free: isFreeModel(model),
    ...(meta.feature ? { feature: meta.feature } : {})
  })
}

/**
 * A call priced by something other than tokens (cloud speech: audio seconds, characters): adds
 * `usd` to the totals and writes the ledger line.
 */
export function recordFlatCall(entry: UsageEntry & { usd: number }, now = new Date()): void {
  addToTotals(round(entry.usd), { ...EMPTY_USAGE }, now)
  recordCall({ ...entry, t: now.getTime() })
}

/** Marks the model that answered the current turn. */
export function noteAnswerModel(model: string): void {
  const turn = turns.getStore()
  if (turn) turn.model = model
}

/** Prompt-cache use over every call after the first: share of calls and of input tokens. */
export function cacheStats(): { callRate: number; tokenRate: number } | null {
  if (cache.calls < 2 || cache.input === 0) return null
  return { callRate: cache.hits / (cache.calls - 1), tokenRate: cache.read / cache.input }
}

export function costTotals(): { sessionUsd: number; dayUsd: number } {
  return { sessionUsd, dayUsd: day.key === dayKey(new Date()) ? day.usd : 0 }
}

/** Session, today (persisted across restarts) and the last 30 days, plus a per-day estimate. */
export function usageOverview(now = new Date()): UsageSummary {
  return usageSummary(sessionUsd, now, unpriced)
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
    const c = cacheStats()
    const pct = (n: number): string => `${Math.round(n * 100)}%`
    const cacheText = c
      ? ` | cache hits ${pct(c.callRate)} of calls, ${pct(c.tokenRate)} of input`
      : ''
    console.log(
      `[cost] turn $${turn.usd.toFixed(4)} (${turn.calls} calls) | session $${session.toFixed(4)} | today $${dayUsd.toFixed(4)}${cacheText}`
    )
    onDone?.(turn)
  }
}

/** Test hook. */
export function resetCostTotals(): void {
  Object.assign(cache, { calls: 0, hits: 0, input: 0, read: 0 })
  sessionUsd = 0
  unpriced = false
  day = { key: '', usd: 0 }
}
