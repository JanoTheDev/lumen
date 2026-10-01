import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordUsage, resetCostTotals, usageOverview } from '../../src/main/ai/cost'
import { flushUsage, setUsagePath, usagePath } from '../../src/main/ai/usage-log'
import type { Usage } from '../../src/main/ai/providers/types'

let dir: string
const usage = (input: number, output: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
})
const day = (iso: string): Date => new Date(`${iso}T12:00:00`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-usage-'))
  setUsagePath(join(dir, 'usage.json'))
  resetCostTotals()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  setUsagePath(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('usage log', () => {
  it('sums calls per local day and persists them across a restart', () => {
    // Haiku 4.5: $1 in / $5 out per MTok → 1M in + 200k out = $2.
    recordUsage('claude-haiku-4-5', usage(1_000_000, 200_000), false, day('2026-09-30'))
    recordUsage('claude-haiku-4-5', usage(500_000, 0), false, day('2026-10-01'))
    recordUsage('claude-haiku-4-5', usage(500_000, 0), false, day('2026-10-01'))
    flushUsage()
    const file = JSON.parse(readFileSync(usagePath(), 'utf8'))
    expect(
      file.days.map((d: { date: string; usd: number; calls: number }) => [d.date, d.usd, d.calls])
    ).toEqual([
      ['2026-09-30', 2, 1],
      ['2026-10-01', 1, 2]
    ])
    // A new process reads the same file.
    setUsagePath(join(dir, 'usage.json'))
    const o = usageOverview(day('2026-10-01'))
    expect(o.today).toMatchObject({ date: '2026-10-01', usd: 1, calls: 2, inputTokens: 1_000_000 })
    expect(o.days).toHaveLength(2)
    expect(o.estimatePerDay).toBe(1.5)
    expect(o.estimatePerMonth).toBe(45)
    expect(o.estimated).toBe(false)
  })

  it('keeps 30 days and estimates from the active days of the last week', () => {
    recordUsage('claude-haiku-4-5', usage(1_000_000, 0), false, day('2026-08-01'))
    recordUsage('claude-haiku-4-5', usage(3_000_000, 0), false, day('2026-09-28'))
    const o = usageOverview(day('2026-10-01'))
    expect(o.days.map((d) => d.date)).toEqual(['2026-09-28'])
    expect(o.today.usd).toBe(0)
    expect(o.estimatePerDay).toBe(3)
  })

  it('flags unknown model prices; a broken file starts fresh', () => {
    writeFileSync(usagePath(), '{nope')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setUsagePath(usagePath())
    recordUsage('some-new-model', usage(10, 10), false, day('2026-10-01'))
    const o = usageOverview(day('2026-10-01'))
    expect(o.estimated).toBe(true)
    expect(o.days).toHaveLength(1)
  })

  it('writes nothing unless enabled', () => {
    setUsagePath(null)
    recordUsage('claude-haiku-4-5', usage(10, 10), false, day('2026-10-01'))
    flushUsage()
    expect(existsSync(join(dir, 'usage.json'))).toBe(false)
  })
})
