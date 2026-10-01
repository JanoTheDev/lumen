import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { convertLocally } from '../../src/main/docs-out/answer'
import { sheetsToXlsx, sheetTooBig } from '../../src/main/docs-out/xlsx'
import { tableStats } from '../../src/main/files/office'
import { readZip } from '../../src/main/packs/zip-read'
import { tempDir } from '../helpers/fixtures'

describe('large tables (review M3)', () => {
  it('tableStats on 300k numeric rows has the right min and max', () => {
    const rows = [['n'], ...Array.from({ length: 300_000 }, (_, i) => [String(i - 5)])]
    const s = tableStats(rows)
    expect(s.rows).toBe(300_000)
    expect(s.columns[0]).toMatchObject({ min: -5, max: 299_994 })
  })

  it('sheetsToXlsx takes 300k rows', () => {
    const rows = Array.from({ length: 300_000 }, (_, i) => [String(i), 'x'])
    expect(() => sheetsToXlsx([{ name: 'big', rows }])).not.toThrow()
  })

  it('a sheet past Excel limits is refused, never cut', () => {
    expect(sheetTooBig([Array.from({ length: 16_385 }, () => 'a')])).toMatch(/columns/)
    expect(() => sheetsToXlsx([{ name: 'w', rows: [Array(16_385).fill('a')] }])).toThrow(
      /too big for Excel/
    )
  })

  it('convertLocally turns a 200k-row CSV into an Excel file', async () => {
    const t = tempDir('convert-')
    try {
      const path = join(t.dir, 'export.csv')
      const lines = ['id,amount', ...Array.from({ length: 200_000 }, (_, i) => `${i},${i * 2}`)]
      writeFileSync(path, lines.join('\n'))
      const bytes = await convertLocally(
        { id: 'f_1', name: 'export.csv', size: 1, kind: 'text', path, fresh: true },
        'xlsx'
      )
      expect(Buffer.isBuffer(bytes)).toBe(true)
      const sheet = readZip(bytes as Buffer, { maxBytes: 200 * 1024 * 1024, maxEntries: 50 })
        .find((f) => f.name === 'xl/worksheets/sheet1.xml')!
        .data.toString('utf8')
      expect(sheet).toContain('<row r="200001">')
    } finally {
      t.cleanup()
    }
  }, 30_000)
})
