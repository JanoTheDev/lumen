import type { Usage } from './providers/types'

// USD per million tokens.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10.0 }
}

const FALLBACK = { input: 3.0, output: 15.0 }

export function usageCost(
  model: string,
  usage: Usage
): { input: number; output: number; total: number } {
  const p = PRICING[model] ?? FALLBACK
  const inTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const input = (inTokens / 1_000_000) * p.input
  const output = (usage.outputTokens / 1_000_000) * p.output
  return { input, output, total: input + output }
}

export function logUsage(model: string, usage: Usage, hasImage: boolean): void {
  const { inputTokens, outputTokens } = usage
  const cost = usageCost(model, usage)
  const imageNote = hasImage ? ' +vision (img tokens in "in")' : ''
  console.log(
    `[tokens] ${model}${imageNote} | in:${inputTokens} out:${outputTokens} | $${cost.total.toFixed(4)} (in:$${cost.input.toFixed(4)} out:$${cost.output.toFixed(4)})`
  )
}
