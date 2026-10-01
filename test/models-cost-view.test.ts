import { describe, expect, it } from 'vitest'
import type { UsageDay, UsageOverview } from '@shared/channels'
import { costView, usd } from '../src/renderer/src/panel/settings/sections/ModelsCostView'

const day = (date: string, cost: number, calls: number): UsageDay => ({
  date,
  usd: cost,
  calls,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
})

describe('models cost view', () => {
  it('formats money', () => {
    expect(usd(0)).toBe('$0')
    expect(usd(0.004)).toBe('under $0.01')
    expect(usd(0.4213)).toBe('$0.42')
    expect(usd(12.4)).toBe('$12')
  })

  it('no data yet', () => {
    const u: UsageOverview = {
      today: day('2026-10-01', 0, 0),
      sessionUsd: 0,
      days: [],
      estimatePerDay: 0,
      estimatePerMonth: 0,
      estimated: false
    }
    expect(costView(u).estimate).toContain('No model use yet')
    expect(costView(u).recent).toEqual([])
  })

  it('estimate, today and recent days newest first', () => {
    const now = new Date(2026, 9, 1, 12)
    const u: UsageOverview = {
      today: day('2026-10-01', 0.12, 3),
      sessionUsd: 0.05,
      days: [day('2026-09-30', 0.2, 10), day('2026-10-01', 0.12, 3)],
      estimatePerDay: 0.16,
      estimatePerMonth: 4.8,
      estimated: true
    }
    const v = costView(u, now)
    expect(v.estimate).toBe('About $0.16 a day ($4.80 a month) at your recent use.')
    expect(v.today).toBe('Today $0.12 (3 requests), since Lumen started $0.05.')
    expect(v.recent).toEqual([
      ['Today', '$0.12 · 3 requests'],
      ['Yesterday', '$0.20 · 10 requests']
    ])
    expect(v.note).toBeDefined()
  })
})
