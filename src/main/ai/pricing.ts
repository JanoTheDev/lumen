// USD per million tokens.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00  },
  'gpt-5-mini':                { input: 0.25,  output: 2.00  },
  'gpt-5-nano':                { input: 0.05,  output: 0.40  },
  'gpt-4o':                    { input: 2.50,  output: 10.00 },
}

const FALLBACK = { input: 3.00, output: 15.00 }

export function usageCost(model: string, inputTokens: number, outputTokens: number): { input: number; output: number; total: number } {
  const p = PRICING[model] ?? FALLBACK
  const input = (inputTokens / 1_000_000) * p.input
  const output = (outputTokens / 1_000_000) * p.output
  return { input, output, total: input + output }
}

export function logUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  hasImage: boolean
): void {
  const cost = usageCost(model, inputTokens, outputTokens)
  const imageNote = hasImage ? ' +vision (img tokens in "in")' : ''
  console.log(
    `[tokens] ${model}${imageNote} | in:${inputTokens} out:${outputTokens} | $${cost.total.toFixed(4)} (in:$${cost.input.toFixed(4)} out:$${cost.output.toFixed(4)})`
  )
}
