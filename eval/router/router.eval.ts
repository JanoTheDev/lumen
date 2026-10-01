// Live router eval: scores the LLM router's mode against eval/router/utterances.json.
// Calls the real fast model (costs money), so it is NOT part of `npm test`.
// Run: npm run eval:router   (env: ROUTER_EVAL_LIMIT=n, ROUTER_EVAL_CONCURRENCY=n)
import { readFileSync } from 'fs'
import { join } from 'path'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect } from 'vitest'
import { routeWithLlm, type Route } from '../../src/main/query/router'
import { onUsage } from '../../src/main/ai/providers'
import { usageCost } from '../../src/main/ai/pricing'

loadEnv({ path: join(__dirname, '../../.env'), quiet: true })

interface Case {
  id: number
  utterance: string
  foreground: string
  guideActive: boolean
  mode?: string
  appSwitch?: boolean
  split?: number
  tags?: string[]
}

const TARGET_ACCURACY = 0.95
const TARGET_P50_MS = 350

const cases = (
  JSON.parse(readFileSync(join(__dirname, 'utterances.json'), 'utf8')) as { cases: Case[] }
).cases.filter((c) => c.mode)

const limit = Number(process.env.ROUTER_EVAL_LIMIT) || cases.length
const concurrency = Number(process.env.ROUTER_EVAL_CONCURRENCY) || 4
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

describe.skipIf(!hasKey)('router eval (live)', () => {
  it(`mode accuracy >= ${TARGET_ACCURACY * 100}%`, { timeout: 15 * 60_000 }, async () => {
    let usd = 0
    onUsage((model, usage) => (usd += usageCost(model, usage).total))
    // Router logs go to the console; keep only the report.
    const log = console.log
    console.log = () => {}

    const todo = cases.slice(0, limit)
    const results: { c: Case; route: Route | null; ms: number }[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const c = todo[next++]
        const t0 = Date.now()
        const route = await routeWithLlm({
          utterance: c.utterance,
          activeWindow: c.foreground,
          guideActive: c.guideActive
        })
        results.push({ c, route, ms: Date.now() - t0 })
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    console.log = log

    results.sort((a, b) => a.c.id - b.c.id)
    const correct = results.filter((r) => r.route?.mode === r.c.mode)
    const switchCases = results.filter((r) => r.c.appSwitch !== undefined)
    const switchOk = switchCases.filter((r) => r.route?.appSwitch === r.c.appSwitch)
    const splitCases = results.filter((r) => r.c.split)
    const splitOk = splitCases.filter((r) => r.route?.parallelSplit?.length === r.c.split)
    const ms = results.map((r) => r.ms).sort((a, b) => a - b)
    const accuracy = correct.length / results.length

    const byMode = new Map<string, { n: number; ok: number }>()
    for (const r of results) {
      const m = byMode.get(r.c.mode!) ?? { n: 0, ok: 0 }
      m.n++
      if (r.route?.mode === r.c.mode) m.ok++
      byMode.set(r.c.mode!, m)
    }

    const lines = [
      `router eval: ${correct.length}/${results.length} mode correct (${(accuracy * 100).toFixed(1)}%, target ${TARGET_ACCURACY * 100}%)`,
      `latency p50 ${pct(ms, 50)}ms, p95 ${pct(ms, 95)}ms (target p50 <= ${TARGET_P50_MS}ms)`,
      `appSwitch ${switchOk.length}/${switchCases.length}, parallelSplit ${splitOk.length}/${splitCases.length}`,
      `cost $${usd.toFixed(4)} total, $${(usd / Math.max(1, results.length)).toFixed(5)} per call`,
      'per mode: ' + [...byMode].map(([m, s]) => `${m} ${s.ok}/${s.n}`).join(', '),
      ...results
        .filter((r) => r.route?.mode !== r.c.mode)
        .map(
          (r) =>
            `  MISS #${r.c.id} "${r.c.utterance}" [${r.c.foreground}${r.c.guideActive ? ', guide' : ''}] expected ${r.c.mode}, got ${r.route ? `${r.route.mode} (${r.route.confidence})` : 'null'}`
        )
    ]
    console.log(lines.join('\n'))
    expect(accuracy).toBeGreaterThanOrEqual(TARGET_ACCURACY)
  })
})
