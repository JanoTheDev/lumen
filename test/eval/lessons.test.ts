// The offline lesson-check eval as a regression test: the cases validate, the scorer counts
// false passes / false fails, and the production checks get every case right except the
// documented gaps (plans/10-quality/tasks.md, "T15-G…" notes), which are it.fails below.
import { beforeAll, describe, expect, it } from 'vitest'
import {
  STRATEGIES,
  fixtureExists,
  formatReport,
  loadCases,
  rates,
  run,
  score,
  validateCase,
  loadFixture,
  type Case,
  type Fixture,
  type Result
} from '../../eval/lessons/runner'

/** Upper bound for the deterministic false-fail rate over all cases (known gaps included). */
const FALSE_FAIL_BOUND = 0.15

const cases = loadCases()
let results: Result[] = []
const det = (): Result[] => results.filter((r) => r.strategy === 'deterministic')
const wrong = (r: Result): boolean => r.falsePass || r.falseFail
const gapCases = (gap: string): Result[] => det().filter((r) => r.case.knownGap === gap)

const fixtures = new Map<string, Fixture>()
const load = (name: string): Fixture => {
  if (!fixtures.has(name)) fixtures.set(name, loadFixture(name))
  return fixtures.get(name)!
}

beforeAll(async () => {
  results = await run(STRATEGIES, cases, load)
}, 60_000)

describe('lesson-check eval', () => {
  it('every case validates and covers 3+ apps', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const c of cases)
      expect([c.id, validateCase(c, (f) => fixtureExists(f), load)]).toEqual([c.id, []])
    expect(new Set(cases.map((c) => c.fixture.split('/')[0])).size).toBeGreaterThanOrEqual(3)
    expect(cases.some((c) => c.truth === 'fail' && c.category === 'similar-name')).toBe(true)
    expect(cases.some((c) => c.category === 'stale-state')).toBe(true)
    expect(cases.some((c) => c.category === 'partial')).toBe(true)
  }, 30_000)

  it('scores a pass on a not-done step as false-pass, a fail on a done one as false-fail', () => {
    const c = { truth: 'fail' } as Case
    const o = { latencyMs: 0 }
    expect(score(c, { ...o, verdict: 'pass' })).toEqual({ falsePass: true, falseFail: false })
    expect(score(c, { ...o, verdict: 'manual' })).toEqual({ falsePass: false, falseFail: false })
    const p = { truth: 'pass' } as Case
    expect(score(p, { ...o, verdict: 'fail' })).toEqual({ falsePass: false, falseFail: true })
    expect(score(p, { ...o, verdict: 'unknown' })).toEqual({ falsePass: false, falseFail: false })
  })

  it('the production checks: no false pass or false fail outside the known gaps', () => {
    const misses = det()
      .filter((r) => !r.case.knownGap && wrong(r))
      .map((r) => `${r.case.id}: ${r.out.verdict}`)
    expect(misses).toEqual([])
    const clean = rates(det().filter((r) => !r.case.knownGap))
    expect(clean.falsePass).toBe(0)
    expect(clean.falseFail).toBe(0)
    expect(rates(det()).falseFail).toBeLessThanOrEqual(FALSE_FAIL_BOUND)
  })

  it('the mock is right about half the time and the report has its sections', () => {
    const mock = results.filter((r) => r.strategy === 'mock')
    const right = mock.filter((r) => !wrong(r)).length / mock.length
    expect(right).toBeGreaterThan(0.2)
    expect(right).toBeLessThan(0.9)
    const report = formatReport(results, { date: '2026-10-02', sha: 'test' })
    expect(report).toContain('## Per app × category')
    expect(report).toContain('Not run offline: vision')
    expect(report).toMatch(/\| deterministic \| all \| \d+ \|/)
  })

  // Known gaps: each names its note in plans/10-quality/tasks.md. Flip to it() once fixed.
  it('T15-G1: window-opened {name} does not pass on a same-named button', () => {
    expect(gapCases('T15-G1').filter(wrong)).toEqual([])
  })
  it.fails('T15-G2: a value check on a role alone does not pass on another ComboBox', () => {
    expect(gapCases('T15-G2').filter(wrong)).toEqual([])
  })
  it.fails('T15-G3: closing Settings with Cancel does not pass a save step', () => {
    expect(gapCases('T15-G3').filter(wrong)).toEqual([])
  })
  it.fails('T15-G4: a bridge fail is not overridden by a manual alternative', () => {
    expect(gapCases('T15-G4').map((r) => r.out.verdict)).toEqual(['fail'])
  })
  it.fails('T15-G5: window-opened evaluate sees the dialog that is the snapshot root', () => {
    expect(gapCases('T15-G5').filter(wrong)).toEqual([])
  })
  it.fails('T15-G6: selected / checked state is readable without an event', () => {
    expect(gapCases('T15-G6').filter(wrong)).toEqual([])
  })
})
