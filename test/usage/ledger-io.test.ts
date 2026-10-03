import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, statSync: vi.fn(real.statSync), readdirSync: vi.fn(real.readdirSync) }
})

import {
  flushLedger,
  importRows,
  queryUsage,
  recordCall,
  resetLedgerCache,
  setLedgerDir,
  type UsageRow
} from '../../src/main/usage/ledger'

let dir: string
const at = (iso: string): number => new Date(`${iso}T12:00:00`).getTime()

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'ai-overlay-ledger-io-'))
  setLedgerDir(dir)
  vi.mocked(fs.statSync).mockClear()
  vi.mocked(fs.readdirSync).mockClear()
})

afterEach(() => {
  setLedgerDir(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const call = (t: number, n = 1): void => {
  recordCall({ provider: 'anthropic', model: 'm', in: n, out: 1, usd: 0.01, t })
}

describe('ledger disk access', () => {
  it('checks a month file for a torn line once, on the first flush', () => {
    fs.writeFileSync(join(dir, '2026-10.ndjson'), '{"t":1,"mo')
    call(at('2026-10-02'), 7)
    flushLedger()
    expect(fs.statSync).toHaveBeenCalledTimes(1)
    call(at('2026-10-02'), 8)
    flushLedger()
    expect(fs.statSync).toHaveBeenCalledTimes(1)
    resetLedgerCache()
    const rows = queryUsage({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) })
    expect(rows.map((r) => r.in)).toEqual([7, 8])
  })

  it('lists the folder once; a new month joins the list', () => {
    call(at('2026-09-02'))
    flushLedger()
    queryUsage({ from: 0 })
    queryUsage({ from: 0 })
    expect(fs.readdirSync).toHaveBeenCalledTimes(1)
    call(at('2026-10-01'))
    flushLedger()
    expect(queryUsage({ from: 0 })).toHaveLength(2)
    expect(fs.readdirSync).toHaveBeenCalledTimes(1)
  })

  it('rows that arrive out of order still come back oldest first', () => {
    call(at('2026-09-05'), 1)
    call(at('2026-09-03'), 2)
    importRows([{ ...queryUsage({ from: 0 })[0], t: at('2026-09-04'), in: 3 } as UsageRow])
    expect(queryUsage({ from: 0 }).map((r) => r.in)).toEqual([2, 3, 1])
    flushLedger()
    resetLedgerCache()
    expect(queryUsage({ from: 0 }).map((r) => r.in)).toEqual([2, 3, 1])
  })
})
