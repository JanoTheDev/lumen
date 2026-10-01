// Offline grounding eval: every strategy in strategies.ts over eval/grounding/cases.jsonl.
// Free (no model calls), writes eval/reports/<date>-<sha>.md and a .json sibling.
// Run: npm run eval:grounding   (env: GROUNDING_STRATEGY=auto,uia-text  GROUNDING_LIMIT=n)
import { execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import { formatReport, hitRate, loadCases, run } from './runner'
import { STRATEGIES } from './strategies'

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'nogit'
  }
}

describe('grounding eval', () => {
  it('runs every strategy and writes the report', async () => {
    const only = process.env.GROUNDING_STRATEGY?.split(',').filter(Boolean)
    const strategies = Object.fromEntries(
      Object.entries(STRATEGIES).filter(([name]) => !only?.length || only.includes(name))
    )
    const limit = Number(process.env.GROUNDING_LIMIT) || Infinity
    const cases = loadCases().slice(0, limit)
    const results = await run(strategies, cases)

    const date = new Date().toISOString().slice(0, 10)
    const sha = gitSha()
    const dir = join(__dirname, '../reports')
    mkdirSync(dir, { recursive: true })
    const base = join(dir, `${date}-${sha}`)
    writeFileSync(`${base}.md`, formatReport(results, { date, sha }) + '\n')
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        results.map((r) => ({ id: r.case.id, strategy: r.strategy, hit: r.hit, out: r.out })),
        null,
        2
      )
    )
    for (const name of Object.keys(strategies))
      console.log(`${name}: ${Math.round(hitRate(results, name) * 100)}% hit`)
    console.log(`report: ${base}.md`)
    expect(results.length).toBe(cases.length * Object.keys(strategies).length)
  })
})
