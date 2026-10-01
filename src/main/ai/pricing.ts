import type { Usage } from './providers/types'

/** USD per million tokens. Cache writes use the 5-minute TTL rate (1.25x input). */
export interface Rate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const PRICING: Record<string, Rate> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  // Gemini paid tier (ai.google.dev/gemini-api/docs/pricing, 2026-10-01; 3.8 Flash at its
  // launch price until 2026-12-31). Calls through the gemini provider are free-tier and count
  // as $0 (markFreeModel); these apply when a paid route names the same id.
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 }
}

const FREE: Rate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
// Models served by a local server or the Gemini free tier cost nothing.
const freeModels = new Set<string>()
// Prices a service listed for its models (OpenRouter /models), USD per million tokens.
const listed = new Map<string, Rate>()

/** Marks a model as free (local, Gemini free tier) or, with `free: false`, as priced again. */
export function markFreeModel(model: string, free = true): void {
  if (free) freeModels.add(model)
  else freeModels.delete(model)
}

/** A price a service reports for one of its models (e.g. OpenRouter's /models list). */
export function registerModelPrice(model: string, rate: Rate): void {
  listed.set(model, rate)
}

/**
 * Rate for a model id; dated snapshots (`-20251001`, `-2025-08-07`) use their alias's rate. A
 * model without a known price has no estimate: $0 and `known: false` (the Cost card says so).
 */
export function rateFor(model: string): Rate & { known: boolean } {
  if (freeModels.has(model)) return { ...FREE, known: true }
  const own = listed.get(model)
  if (own) return { ...own, known: true }
  const alias = model.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
  const rate = PRICING[alias]
  return rate ? { ...rate, known: true } : { ...FREE, known: false }
}

/**
 * Rate the task cost caps use for a model without a known price (Sonnet 5.5's), so a paid
 * service the table does not know still runs into the agent and background caps.
 */
export const CAP_FALLBACK_RATE: Rate = PRICING['claude-sonnet-5-5']

export interface Cost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

// tokens × USD/MTok = micro-USD. Amounts are rounded to the nano-dollar so float noise never
// leaks into sums.
const NANO = 1_000_000_000
export const roundUsd = (n: number): number => Math.round(n * NANO) / NANO
const usd = (tokens: number, perMTok: number): number => roundUsd((tokens * perMTok) / 1_000_000)

function costAt(r: Rate, usage: Usage): Cost {
  const input = usd(usage.inputTokens, r.input)
  const output = usd(usage.outputTokens, r.output)
  const cacheRead = usd(usage.cacheReadTokens, r.cacheRead)
  const cacheWrite = usd(usage.cacheWriteTokens, r.cacheWrite)
  const total = roundUsd(input + output + cacheRead + cacheWrite)
  return { input, output, cacheRead, cacheWrite, total }
}

/** What a call cost, for display and the usage log: $0 when the price is not known. */
export function knownCost(model: string, usage: Usage): Cost {
  return costAt(rateFor(model), usage)
}

/**
 * What a call cost for the task caps (agent, background, how-to): a model without a known
 * price counts at CAP_FALLBACK_RATE instead of $0.
 */
export function usageCost(model: string, usage: Usage): Cost {
  const r = rateFor(model)
  return costAt(r.known ? r : CAP_FALLBACK_RATE, usage)
}

export function formatUsage(model: string, usage: Usage, hasImage: boolean): string {
  const cost = knownCost(model, usage)
  const cache =
    usage.cacheReadTokens || usage.cacheWriteTokens
      ? ` cache r:${usage.cacheReadTokens} w:${usage.cacheWriteTokens}`
      : ''
  const image = hasImage ? ' +vision' : ''
  const unknown = rateFor(model).known ? '' : ' (no known price)'
  return `[tokens] ${model}${image} | in:${usage.inputTokens} out:${usage.outputTokens}${cache} | $${cost.total.toFixed(4)}${unknown}`
}
