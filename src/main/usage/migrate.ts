// One-time import of the old per-day usage file (~/.ai-overlay/usage.json, ai/usage-log before
// 05 T43) into the ledger: one line per day with its totals, origin 'system', feature
// 'migrated'. The old file is kept; a marker in the ledger folder stops a second import.
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { configPath } from '../config'
import { buildRow, hasMarker, importRows, ledgerPersisting, writeMarker } from './ledger'
import type { UsageRow } from './ledger'

const MARKER = '.migrated-usage-json'

export function oldUsagePath(): string {
  return join(dirname(configPath()), 'usage.json')
}

interface OldDay {
  date?: unknown
  usd?: unknown
  calls?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The old file's days as ledger lines (noon local time of each day). Pure apart from reading. */
export function oldDaysToRows(days: OldDay[]): UsageRow[] {
  const rows: UsageRow[] = []
  for (const d of days) {
    if (typeof d?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue
    const calls = num(d.calls)
    if (calls <= 0) continue
    const [y, m, day] = d.date.split('-').map(Number)
    rows.push(
      buildRow(
        {
          t: new Date(y, m - 1, day, 12).getTime(),
          provider: 'unknown',
          model: 'unknown',
          in: num(d.inputTokens),
          out: num(d.outputTokens),
          cacheRead: num(d.cacheReadTokens),
          cacheWrite: num(d.cacheWriteTokens),
          usd: num(d.usd),
          calls
        },
        { origin: 'system', feature: 'migrated' }
      )
    )
  }
  return rows
}

/** Imports the old file once. Returns the number of days imported. Never throws. */
export function migrateOldUsage(path = oldUsagePath()): number {
  if (!ledgerPersisting() || hasMarker(MARKER)) return 0
  try {
    let rows: UsageRow[] = []
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { days?: unknown }
      rows = oldDaysToRows(Array.isArray(file.days) ? (file.days as OldDay[]) : [])
      importRows(rows)
    }
    writeMarker(MARKER)
    if (rows.length) console.log(`[usage] imported ${rows.length} days from usage.json`)
    return rows.length
  } catch (e) {
    console.warn(`[usage] usage.json not imported: ${(e as Error).message}`)
    try {
      writeMarker(MARKER)
    } catch {
      // try again next start
    }
    return 0
  }
}
