import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { installAudit, listAudit, uninstallAudit } from '../../src/main/audit/log'
import { tempDir } from '../helpers/fixtures'

let tmp: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  uninstallAudit()
  tmp?.cleanup()
  tmp = null
  vi.restoreAllMocks()
})

const DAY = '2026-10-03'
const base = Date.parse(`${DAY}T00:00:00.000Z`)
const line = (i: number): string =>
  JSON.stringify({
    t: new Date(base + i * 1000).toISOString(),
    task: 'bg_x',
    origin: 'agent',
    action: { type: 'click', element: `Button ${i}` },
    risk: 'low',
    decision: 'auto',
    result: 'ok'
  })

describe('listAudit with a time range', () => {
  it('parses only the lines inside the range', () => {
    tmp = tempDir()
    installAudit(tmp.dir, 30, base)
    const n = 50_000
    writeFileSync(
      join(tmp.dir, `${DAY}.ndjson`),
      Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
    )
    const parse = vi.spyOn(JSON, 'parse')
    const range = { from: base + 1000 * 1000, to: base + 1100 * 1000 }
    const got = listAudit(DAY, undefined, range)
    expect(got).toHaveLength(100)
    expect(got[0].action.element).toBe('Button 1000')
    expect(parse).toHaveBeenCalledTimes(100)
    parse.mockRestore()
    const all = listAudit(DAY)
    expect(all).toHaveLength(n)
    expect(
      all.filter((e) => {
        const t = Date.parse(e.t)
        return t >= range.from && t < range.to
      })
    ).toEqual(got)
  })
})
