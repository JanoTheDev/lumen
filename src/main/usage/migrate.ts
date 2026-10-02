// One-time import of the old per-day usage file (~/.ai-overlay/usage.json, ai/usage-log before
// 05 T43) into the ledger: one line per day with its totals, origin 'system', feature
// 'migrated'. The old file is kept; a marker in the ledger folder stops a second import.
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { configPath } from '../config'
import {
  buildRow,
  dayKey,
  hasMarker,
  importRows,
  ledgerPersisting,
  queryUsage,
  writeMarker
} from './ledger'
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

/** Day keys (YYYY-MM-DD) of the migrated lines already in the ledger. */
function importedDays(): Set<string> {
  const days = new Set<string>()
  for (const r of queryUsage({ from: 0, filter: { origin: 'system', feature: 'migrated' } }))
    days.add(dayKey(r.t))
  return days
}

/**
 * Imports the old file once. Days already in the ledger (a run cut short before its marker) are
 * skipped, so a second run never doubles them; the marker, written last with the imported day
 * keys, is set only once every day is in. Returns the number of days imported. Never throws.
 */
export function migrateOldUsage(path = oldUsagePath()): number {
  if (!ledgerPersisting() || hasMarker(MARKER)) return 0
  try {
    let rows: UsageRow[] = []
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      let file: { days?: unknown }
      try {
        file = JSON.parse(text) as { days?: unknown }
      } catch (e) {
        // Not JSON: it never will be, so it is not read again at every start.
        writeMarker(MARKER, JSON.stringify({ days: [], unreadable: true }))
        console.warn(`[usage] usage.json is not valid JSON, not imported: ${(e as Error).message}`)
        return 0
      }
      const done = importedDays()
      rows = oldDaysToRows(Array.isArray(file.days) ? (file.days as OldDay[]) : []).filter(
        (r) => !done.has(dayKey(r.t))
      )
      importRows(rows)
    }
    writeMarker(MARKER, JSON.stringify({ days: rows.map((r) => dayKey(r.t)) }))
    if (rows.length) console.log(`[usage] imported ${rows.length} days from usage.json`)
    return rows.length
  } catch (e) {
    // A read or write failure: tried again next start; the days that made it are skipped then.
    console.warn(`[usage] usage.json not imported: ${(e as Error).message}`)
    return 0
  }
}
