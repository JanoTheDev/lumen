// Settings → Usage (05 T44): view helpers and static markup (there is no DOM library in this
// repo; keyboard and screen reader behaviour is a hand test).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageDayBar, UsageReport, UsageSums, UsageTableRow } from '@shared/usage'
import { USAGE_BUCKETS } from '@shared/usage'
import {
  chartGeometry,
  chartSummary,
  costLine,
  money,
  notes,
  sortRows,
  tokens
} from '../../src/renderer/src/panel/settings/sections/usage-view'
import { DayChart, UsageTable } from '../../src/renderer/src/panel/settings/sections/Usage'
import { filterSections } from '../../src/renderer/src/panel/settings/meta'

const sums = (p: Partial<UsageSums>): UsageSums => ({
  calls: 1,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
  audioSec: 0,
  usd: 0,
  unpriced: 0,
  free: 0,
  ...p
})

const zero = (): Record<(typeof USAGE_BUCKETS)[number], number> =>
  Object.fromEntries(USAGE_BUCKETS.map((b) => [b, 0])) as never

const bar = (day: string, you: number, tasks = 0): UsageDayBar => ({
  day,
  usd: { ...zero(), you, tasks },
  tokens: { ...zero(), you: you * 1000, tasks: tasks * 1000 }
})

describe('usage view helpers', () => {
  it('formats money and tokens', () => {
    expect(money(0)).toBe('$0')
    expect(money(0.004)).toBe('<$0.01')
    expect(money(1.234)).toBe('$1.23')
    expect(money(250.4)).toBe('$250')
    expect(tokens(950)).toBe('950')
    expect(tokens(1234)).toBe('1.2k')
    expect(tokens(45_000)).toBe('45k')
    expect(tokens(2_500_000)).toBe('2.5M')
  })

  it('cost line for rows', () => {
    expect(costLine(undefined)).toBe('')
    expect(costLine({ usd: 0, tokens: 0, calls: 0, unpriced: 0 })).toBe('')
    expect(costLine({ usd: 0.031, tokens: 12_300, calls: 3, unpriced: 0 })).toBe(
      '$0.03 · 12k tokens'
    )
    expect(costLine({ usd: 0, tokens: 500, calls: 1, unpriced: 1 })).toContain('no price')
  })

  it('sorts rows', () => {
    const rows: UsageTableRow[] = [
      { key: 'b', name: 'Beta', sums: sums({ usd: 1, calls: 5 }) },
      { key: 'a', name: 'alpha', sums: sums({ usd: 2, calls: 1 }) }
    ]
    expect(sortRows(rows, 'name', 'asc').map((r) => r.key)).toEqual(['a', 'b'])
    expect(sortRows(rows, 'calls', 'desc').map((r) => r.key)).toEqual(['b', 'a'])
    expect(sortRows(rows, 'usd', 'asc').map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('notes unpriced and free calls', () => {
    expect(notes(sums({}))).toEqual([])
    const n = notes(sums({ unpriced: 2, free: 1 }))
    expect(n[0]).toMatch(/2 calls .* without a known price/)
    expect(n[1]).toMatch(/1 call ran on a local model/)
  })

  it('stacks bars bottom-up with gaps, scaled to the biggest day', () => {
    const g = chartGeometry([bar('2026-10-01', 1, 1), bar('2026-10-02', 0)], 'usd', 200, 100)
    expect(g.max).toBe(2)
    expect(g.buckets).toEqual(['you', 'tasks'])
    const [you, tasks] = g.bars[0].segments
    expect(you.y).toBe(50)
    expect(you.h).toBe(50)
    expect(tasks.y).toBe(0)
    expect(tasks.h).toBe(48)
    expect(g.bars[1].segments).toEqual([])
    expect(chartSummary(g, 'usd')).toContain('$2.00')
    expect(chartSummary(chartGeometry([bar('2026-10-01', 0)], 'usd', 10, 10), 'usd')).toBe(
      'No use in this range.'
    )
  })

  it('settings search finds the page', () => {
    expect(filterSections('spend tokens').map((s) => s.id)).toContain('usage')
  })
})

describe('usage markup', () => {
  it('table: caption, sortable headers, row buttons, no-price flag', () => {
    const html = renderToStaticMarkup(
      createElement(UsageTable, {
        caption: 'Usage by feature',
        nameLabel: 'Feature',
        onOpen: () => {},
        rows: [{ key: 'answer', name: 'answer', sums: sums({ usd: 0.5, unpriced: 1 }) }]
      })
    )
    expect(html).toContain('<caption')
    expect(html).toContain('aria-sort="descending"')
    expect(html).toContain('scope="row"')
    expect(html).toContain('no price')
    expect(html.match(/<button type="button"/g)?.length).toBe(5)
  })

  it('chart: image with a text summary, legend, table equivalent', () => {
    const report = {
      sums: sums({ usd: 1 }),
      days: [bar('2026-10-01', 1), bar('2026-10-02', 0, 0.5)]
    } as UsageReport
    const html = renderToStaticMarkup(createElement(DayChart, { r: report, onDay: () => {} }))
    expect(html).toMatch(/role="img" aria-label="Per day by who asked/)
    expect(html).toContain('usage-legend')
    expect(html).toContain('Agent tasks')
    expect(html).toContain('Per day as a table')
  })
})
