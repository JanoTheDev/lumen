import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { queryUsage, resetLedgerCache, setLedgerDir, totals } from '../../src/main/usage/ledger'
import { migrateOldUsage } from '../../src/main/usage/migrate'

let dir: string
let old: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-migrate-'))
  old = join(dir, 'usage.json')
  setLedgerDir(join(dir, 'usage'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  setLedgerDir(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const oldDay = (
  date: string,
  usd: number,
  calls: number,
  input: number
): Record<string, unknown> => ({
  date,
  usd,
  calls,
  inputTokens: input,
  outputTokens: 10,
  cacheReadTokens: 5,
  cacheWriteTokens: 1
})

describe('usage.json migration', () => {
  it('imports each day once as a daily-total line and keeps the old file', () => {
    const days = [oldDay('2026-09-30', 2, 3, 100), oldDay('2026-10-01', 1, 1, 50)]
    writeFileSync(old, JSON.stringify({ version: 1, days: [...days, { date: 'bad', calls: 9 }] }))
    expect(migrateOldUsage(old)).toBe(2)
    expect(migrateOldUsage(old)).toBe(0)
    expect(existsSync(old)).toBe(true)
    resetLedgerCache()
    const rows = queryUsage({
      from: new Date('2026-09-01T00:00:00'),
      to: new Date('2026-11-01T00:00:00')
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ origin: 'system', feature: 'migrated', calls: 3, in: 100 })
    expect(totals(rows)).toMatchObject({ calls: 4, usd: 3, in: 150, cacheRead: 10 })
  })

  it('does nothing without persistence or an old file', () => {
    expect(migrateOldUsage(join(dir, 'missing.json'))).toBe(0)
    setLedgerDir(null)
    writeFileSync(old, JSON.stringify({ version: 1, days: [oldDay('2026-10-01', 1, 1, 1)] }))
    expect(migrateOldUsage(old)).toBe(0)
  })

  it('a run cut short before its marker never doubles days (review L4)', () => {
    writeFileSync(old, JSON.stringify({ version: 1, days: [oldDay('2026-09-30', 2, 3, 100)] }))
    expect(migrateOldUsage(old)).toBe(1)
    // As if the app quit between the import and the marker.
    rmSync(join(dir, 'usage', '.migrated-usage-json'))
    writeFileSync(
      old,
      JSON.stringify({
        version: 1,
        days: [oldDay('2026-09-30', 2, 3, 100), oldDay('2026-10-01', 1, 1, 50)]
      })
    )
    expect(migrateOldUsage(old)).toBe(1)
    resetLedgerCache()
    const rows = queryUsage({
      from: new Date('2026-09-01T00:00:00'),
      to: new Date('2026-11-01T00:00:00')
    })
    expect(totals(rows)).toMatchObject({ calls: 4, usd: 3 })
  })
})
