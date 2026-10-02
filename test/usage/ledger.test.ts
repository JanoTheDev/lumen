import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  flushLedger,
  ledgerMonths,
  monthTotals,
  pruneLedger,
  queryUsage,
  recordCall,
  resetLedgerCache,
  setLedgerDir,
  sumBy,
  totals
} from '../../src/main/usage/ledger'
import { withUsageScope } from '../../src/main/usage/scope'

let dir: string
const at = (iso: string): number => new Date(`${iso}T12:00:00`).getTime()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-ledger-'))
  setLedgerDir(dir)
})

afterEach(() => {
  setLedgerDir(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const lines = (month: string): Record<string, unknown>[] =>
  readFileSync(join(dir, `${month}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('usage ledger', () => {
  it('batches lines for a second, then appends them to the month file', () => {
    vi.useFakeTimers()
    recordCall({ t: at('2026-10-01'), provider: 'anthropic', model: 'claude-haiku-4-5', in: 5 })
    recordCall({ t: at('2026-10-02'), provider: 'anthropic', model: 'claude-haiku-4-5', in: 7 })
    expect(existsSync(join(dir, '2026-10.ndjson'))).toBe(false)
    vi.advanceTimersByTime(1000)
    const rows = lines('2026-10')
    expect(rows.map((r) => r.in)).toEqual([5, 7])
    expect(rows[0]).toMatchObject({ origin: 'system', feature: 'other', usd: 0, priced: true })
    expect(rows[0]).not.toHaveProperty('taskId')
  })

  it('fills origin, feature and ids from the usage scope', async () => {
    await withUsageScope({ origin: 'buddy', buddyId: 'b1', taskId: 'bt1' }, async () => {
      await withUsageScope({ origin: 'subagent', feature: 'subagent-reader', taskId: 'j1' }, () =>
        Promise.resolve().then(() =>
          recordCall({ t: at('2026-10-01'), provider: 'openai', model: 'gpt-5-mini' })
        )
      )
    })
    flushLedger()
    expect(lines('2026-10')[0]).toMatchObject({
      origin: 'subagent',
      feature: 'subagent-reader',
      buddyId: 'b1',
      taskId: 'j1',
      parentTaskId: 'bt1'
    })
  })

  it('never writes fields it does not know (no prompt or reply text)', () => {
    const entry = { t: at('2026-10-01'), provider: 'anthropic', model: 'm', text: 'private words' }
    recordCall(entry as never)
    flushLedger()
    expect(readFileSync(join(dir, '2026-10.ndjson'), 'utf8')).not.toContain('private words')
  })

  it('reads months back from disk, across month boundaries, skipping broken lines', () => {
    recordCall({ t: at('2026-09-30'), provider: 'anthropic', model: 'm', usd: 1 })
    recordCall({ t: at('2026-10-01'), provider: 'anthropic', model: 'm', usd: 2 })
    flushLedger()
    const file = join(dir, '2026-10.ndjson')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"t":1,')
    resetLedgerCache()
    const rows = queryUsage({ from: at('2026-09-01'), to: at('2026-10-31') })
    expect(rows.map((r) => r.usd)).toEqual([1, 2])
    expect(queryUsage({ from: at('2026-10-01') - 3600_000, to: at('2026-10-02') })).toHaveLength(1)
  })

  it('totals, groups and month totals keep Claude Code apart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00'))
    const auto = { automationId: 'm1', origin: 'automation' as const }
    recordCall({ provider: 'anthropic', model: 'a', in: 10, out: 5, usd: 0.5, ...auto })
    recordCall({ provider: 'anthropic', model: 'a', in: 20, usd: 0.25, ...auto })
    recordCall({
      provider: 'local',
      model: 'l',
      in: 100,
      free: true,
      buddyId: 'b1',
      origin: 'buddy'
    })
    recordCall({ provider: 'x', model: 'new', in: 1, priced: false })
    recordCall({
      provider: 'claude-code',
      model: 'cc',
      in: 999,
      usd: 9,
      billing: 'claude-code',
      origin: 'claude-code-copilot'
    })
    const rows = queryUsage()
    expect(totals(rows)).toMatchObject({ calls: 4, in: 131, out: 5, usd: 0.75, unpriced: 1 })
    expect(totals(rows, { external: true })).toMatchObject({ calls: 1, in: 999, usd: 9 })
    expect(sumBy(rows, 'origin').map((g) => g.key)).toEqual(['automation', 'buddy', 'system'])
    expect(sumBy(rows, 'providerModel')[0]).toMatchObject({ key: 'anthropic/a' })
    expect(monthTotals({ automationId: 'm1' })).toMatchObject({ calls: 2, usd: 0.75 })
    expect(monthTotals({ buddyId: 'b1' })).toMatchObject({ calls: 1, in: 100, usd: 0 })
    expect(sumBy(rows, 'day')).toEqual([
      { key: '2026-10-15', totals: expect.objectContaining({ calls: 4 }) }
    ])
  })

  it('removes month files older than 13 months', () => {
    for (const m of ['2025-08', '2025-09', '2025-10', '2026-10'])
      writeFileSync(join(dir, `${m}.ndjson`), '')
    pruneLedger(new Date('2026-10-02T12:00:00'))
    expect(ledgerMonths()).toEqual(['2025-10', '2026-10'])
    expect(existsSync(join(dir, '2025-09.ndjson'))).toBe(false)
  })

  it('a torn last line does not swallow the next row (review L3)', () => {
    writeFileSync(join(dir, '2026-10.ndjson'), '{"t":1,"mo')
    recordCall({ provider: 'anthropic', model: 'm', in: 7, out: 1, usd: 0.01, t: at('2026-10-02') })
    flushLedger()
    resetLedgerCache()
    const rows = queryUsage({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ in: 7 })
  })
})
