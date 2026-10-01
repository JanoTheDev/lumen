// The offline grounding eval as a regression test: the cases validate, the scorer follows
// eval-spec §5, and the production resolver (auto) hits every synthetic case.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import {
  fixtureExists,
  formatReport,
  hitRate,
  loadCases,
  run,
  score,
  validateCase,
  type Case,
  type Output
} from '../../eval/grounding/runner'
import { STRATEGIES, labelOf } from '../../eval/grounding/strategies'

const out = (o: Partial<Output>): Output => ({
  confidence: 0.9,
  latencyMs: 0,
  costUsd: 0,
  modelCalls: 0,
  ...o
})

const box: Case = {
  id: 'x',
  fixture: 'notepad/main',
  query: 'q',
  intent: 'click',
  expected: { elementIds: ['e1'], rects: [{ x: 100, y: 100, w: 20, h: 20 }] },
  category: 'text-label',
  uiaQuality: 'good',
  difficulty: 1
}

describe('grounding eval', () => {
  it('every case validates against eval-spec §3', () => {
    const cases = loadCases()
    expect(cases.length).toBeGreaterThanOrEqual(10)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const c of cases)
      expect([c.id, validateCase(c, (f) => fixtureExists(f))]).toEqual([c.id, []])
  })

  it('scores a centre inside the expected rect grown by 4 px, or a listed id', () => {
    expect(score(box, out({ rect: { x: 90, y: 90, w: 20, h: 20 } }))).toBe(true)
    expect(score(box, out({ rect: { x: 120, y: 120, w: 8, h: 8 } }))).toBe(true)
    expect(score(box, out({ rect: { x: 122, y: 122, w: 8, h: 8 } }))).toBe(false)
    expect(score(box, out({ elementId: 'e1' }))).toBe(true)
    expect(score(box, out({ none: true }))).toBe(false)
    const none: Case = { ...box, expected: { none: true } }
    expect(score(none, out({ none: true }))).toBe(true)
    expect(score(none, out({ rect: box.expected.rects![0], confidence: 0.2 }))).toBe(true)
    expect(score(none, out({ rect: { x: 0, y: 0, w: 5, h: 5 } }))).toBe(false)
  })

  it('reads the label and ordinal out of a query', () => {
    expect(labelOf('click the second open link')).toEqual({ text: 'open', nth: 2 })
    expect(labelOf('open the add menu')).toEqual({ text: 'add' })
    expect(labelOf('go to bluetooth & devices')).toEqual({ text: 'bluetooth & devices' })
  })

  it('the production resolver hits every synthetic case; the mock hits about half', async () => {
    const results = await run(STRATEGIES, loadCases())
    const misses = results.filter((r) => r.strategy === 'auto' && !r.hit).map((r) => r.case.id)
    expect(misses).toEqual([])
    expect(hitRate(results, 'mock')).toBeGreaterThan(0.2)
    expect(hitRate(results, 'mock')).toBeLessThan(0.9)
    const report = formatReport(results, { date: '2026-10-01', sha: 'test' })
    expect(report).toContain('## Per category')
    expect(report).toMatch(/\| auto \| all \| \d+ \| 100% \|/)
  })
})
