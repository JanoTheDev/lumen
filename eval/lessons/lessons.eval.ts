// Offline lesson-check eval: every strategy in runner.ts over eval/lessons/cases.jsonl.
// Free (no model calls), writes eval/reports/lessons-<date>-<sha>.md and a .json sibling.
// Run: npm run eval:lessons   (env: LESSONS_STRATEGY=deterministic  LESSONS_LIMIT=n)
import { execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { STRATEGIES, formatReport, loadCases, rates, run } from './runner'

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'nogit'
  }
}

describe('lesson-check eval', () => {
  it('runs every strategy and writes the report', async () => {
    const only = process.env.LESSONS_STRATEGY?.split(',').filter(Boolean)
    const strategies = Object.fromEntries(
      Object.entries(STRATEGIES).filter(([name]) => !only?.length || only.includes(name))
    )
    const limit = Number(process.env.LESSONS_LIMIT) || Infinity
    const cases = loadCases().slice(0, limit)
    const results = await run(strategies, cases)

    const date = new Date().toISOString().slice(0, 10)
    const sha = gitSha()
    const dir = join(__dirname, '../reports')
    mkdirSync(dir, { recursive: true })
    const base = join(dir, `lessons-${date}-${sha}`)
    writeFileSync(`${base}.md`, formatReport(results, { date, sha }) + '\n')
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        {
          rates: Object.fromEntries(
            Object.keys(strategies).map((s) => [s, rates(results.filter((r) => r.strategy === s))])
          ),
          results: results.map((r) => ({
            id: r.case.id,
            strategy: r.strategy,
            truth: r.case.truth,
            verdict: r.out.verdict,
            falsePass: r.falsePass,
            falseFail: r.falseFail,
            ...(r.case.knownGap ? { knownGap: r.case.knownGap } : {})
          }))
        },
        null,
        2
      )
    )
    for (const name of Object.keys(strategies)) {
      const r = rates(results.filter((x) => x.strategy === name))
      console.log(
        `${name}: false-pass ${Math.round(r.falsePass * 100)}%, false-fail ${Math.round(r.falseFail * 100)}%, undecided ${Math.round(r.undecided * 100)}%`
      )
    }
    console.log(`report: ${base}.md`)
    expect(results.length).toBe(cases.length * Object.keys(strategies).length)
  })
})
