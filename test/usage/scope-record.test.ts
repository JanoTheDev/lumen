import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { recordUsage, resetCostTotals } from '../../src/main/ai/cost'
import { onUsage, providerFor, setProvider } from '../../src/main/ai/providers'
import type { LlmProvider } from '../../src/main/ai/providers/types'
import { onUsageRecorded, setLedgerDir, type UsageRow } from '../../src/main/usage/ledger'
import { withUsageFeature, withUsageScope } from '../../src/main/usage/scope'

const REQ = { model: 'claude-haiku-4-5', system: [], messages: [] } as never
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }

function fake(): LlmProvider {
  return {
    id: 'anthropic',
    async complete() {
      await new Promise((r) => setTimeout(r, 5))
      return { text: 'ok', model: 'claude-haiku-4-5', usage } as never
    },
    async *stream() {
      yield* []
    },
    warmup: async () => {}
  }
}

let rows: UsageRow[]
let off: () => void

beforeEach(() => {
  setLedgerDir(null)
  resetCostTotals()
  rows = []
  off = onUsageRecorded((r) => rows.push(r))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  onUsage((m, u, h, meta) =>
    recordUsage(m, u, h, new Date(), { provider: meta.provider, role: meta.role })
  )
  setProvider('anthropic', fake())
})

afterEach(() => {
  off()
  setProvider('anthropic', null)
  onUsage(() => {})
  vi.restoreAllMocks()
})

describe('usage scope reaches the ledger line', () => {
  it('through an async provider call inside nested scopes', async () => {
    await withUsageScope({ origin: 'automation', automationId: 'morning', taskId: 't1' }, () =>
      withUsageFeature('summarize', () => providerFor('anthropic').complete(REQ))
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      origin: 'automation',
      feature: 'summarize',
      automationId: 'morning',
      taskId: 't1',
      in: 1000,
      out: 100,
      priced: true,
      free: false
    })
    // Haiku 4.5: 1000 × $1/M + 100 × $5/M.
    expect(rows[0].usd).toBeCloseTo(0.0015, 9)
  })

  it('outside any scope the call is a system call', async () => {
    await providerFor('anthropic').complete(REQ)
    expect(rows[0]).toMatchObject({ origin: 'system', feature: 'other' })
  })

  it('a paid search line carries its searches and fee', () => {
    const none = { ...usage, inputTokens: 0, outputTokens: 0 }
    recordUsage('claude-haiku-4-5', none, false, new Date(), {
      searches: 2,
      extraUsd: 0.02,
      feature: 'how-to'
    })
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      searches: 2,
      usd: 0.02,
      feature: 'how-to'
    })
  })
})
