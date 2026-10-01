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
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }
}

// Unknown models are priced like the default main model so totals are never zero.
const FALLBACK = PRICING['claude-sonnet-5-5']

/** Rate for a model id; dated snapshots (`-20251001`, `-2025-08-07`) use their alias's rate. */
export function rateFor(model: string): Rate & { known: boolean } {
  const alias = model.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
  const rate = PRICING[alias]
  return rate ? { ...rate, known: true } : { ...FALLBACK, known: false }
}

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

export function usageCost(model: string, usage: Usage): Cost {
  const r = rateFor(model)
  const input = usd(usage.inputTokens, r.input)
  const output = usd(usage.outputTokens, r.output)
  const cacheRead = usd(usage.cacheReadTokens, r.cacheRead)
  const cacheWrite = usd(usage.cacheWriteTokens, r.cacheWrite)
  const total = roundUsd(input + output + cacheRead + cacheWrite)
  return { input, output, cacheRead, cacheWrite, total }
}

export function formatUsage(model: string, usage: Usage, hasImage: boolean): string {
  const cost = usageCost(model, usage)
  const cache =
    usage.cacheReadTokens || usage.cacheWriteTokens
      ? ` cache r:${usage.cacheReadTokens} w:${usage.cacheWriteTokens}`
      : ''
  const image = hasImage ? ' +vision' : ''
  const unknown = rateFor(model).known ? '' : ' (estimated rate)'
  return `[tokens] ${model}${image} | in:${usage.inputTokens} out:${usage.outputTokens}${cache} | $${cost.total.toFixed(4)}${unknown}`
}
