import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rateFor, usageCost } from '../../src/main/ai/pricing'
import {
  costTotals,
  noteAnswerModel,
  recordUsage,
  resetCostTotals,
  withTurnCost,
  type TurnCost
} from '../../src/main/ai/cost'
import type { Usage } from '../../src/main/ai/providers/types'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite
})

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  resetCostTotals()
})
afterEach(() => vi.restoreAllMocks())

describe('pricing', () => {
  it('prices Sonnet 5.5 input, output and both cache rates exactly', () => {
    expect(usageCost('claude-sonnet-5-5', usage(1000, 500, 2000, 4000))).toEqual({
      input: 0.002,
      output: 0.005,
      cacheRead: 0.0004,
      cacheWrite: 0.01,
      total: 0.0174
    })
  })

  it('prices Haiku 4.5 at $1 / $5, dated id included', () => {
    const c = usageCost('claude-haiku-4-5-20251001', usage(1_000_000, 1_000_000))
    expect(c.input).toBe(1)
    expect(c.output).toBe(5)
    expect(rateFor('claude-haiku-4-5').cacheRead).toBe(0.1)
  })

  it('prices Opus 5.5 and gpt-5-mini', () => {
    expect(usageCost('claude-opus-5-5', usage(10_000, 1_000, 10_000)).total).toBe(0.062)
    expect(usageCost('gpt-5-mini', usage(4_000, 200, 1_000)).total).toBe(0.001425)
  })

  it('falls back to the main-model rate for unknown models', () => {
    expect(rateFor('some-new-model')).toMatchObject({ input: 2, output: 10, known: false })
  })
})

describe('turn cost', () => {
  it('sums every call in a turn and keeps session and day totals', async () => {
    let turn: TurnCost | undefined
    await withTurnCost(
      async () => {
        recordUsage('claude-haiku-4-5', usage(2000, 100))
        await Promise.resolve()
        recordUsage('claude-sonnet-5-5', usage(1000, 500, 2000, 4000))
        noteAnswerModel('claude-sonnet-5-5')
      },
      (c) => (turn = c)
    )
    // Haiku: 0.002 + 0.0005; Sonnet: 0.0174
    expect(turn?.usd).toBe(0.0199)
    expect(turn?.calls).toBe(2)
    expect(turn?.model).toBe('claude-sonnet-5-5')
    expect(turn?.usage).toEqual(usage(3000, 600, 2000, 4000))
    recordUsage('gpt-5-nano', usage(1000, 1000))
    expect(costTotals()).toEqual({ sessionUsd: 0.02035, dayUsd: 0.02035 })
  })

  it('keeps concurrent turns apart and reports cost when a turn fails', async () => {
    const seen: number[] = []
    const run = (tokens: number): Promise<void> =>
      withTurnCost(
        async () => {
          await new Promise((r) => setTimeout(r, 1))
          recordUsage('claude-haiku-4-5', usage(tokens, 0))
        },
        (c) => seen.push(c.usd)
      )
    await Promise.all([run(1000), run(3000)])
    expect(seen.sort()).toEqual([0.001, 0.003])

    let failed: TurnCost | undefined
    await expect(
      withTurnCost(
        async () => {
          recordUsage('claude-haiku-4-5', usage(1000, 0))
          throw new Error('boom')
        },
        (c) => (failed = c)
      )
    ).rejects.toThrow('boom')
    expect(failed?.usd).toBe(0.001)
  })

  it('starts a new day total at midnight', () => {
    recordUsage('claude-haiku-4-5', usage(1000, 0), false, new Date(2026, 0, 1, 23, 59))
    recordUsage('claude-haiku-4-5', usage(2000, 0), false, new Date(2026, 0, 2, 0, 1))
    expect(costTotals().sessionUsd).toBe(0.003)
  })
})
