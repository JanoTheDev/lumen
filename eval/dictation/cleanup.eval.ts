// Live dictation cleanup eval: every sample goes through the real fast model and must keep
// its words (eval/dictation/samples.json). Calls a paid model, so it is NOT part of
// `npm test`. Run: npm run eval:dictation
import { readFileSync } from 'fs'
import { join } from 'path'
import { config as loadEnv } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { cleanupDictation, wordsPreserved } from '../../src/main/speech/dictation/cleanup'
import { onUsage } from '../../src/main/ai/providers'
import { usageCost } from '../../src/main/ai/pricing'

loadEnv({ path: join(__dirname, '../../.env'), quiet: true })

interface Sample {
  id: number
  raw: string
  tags: string[]
}

const data = JSON.parse(readFileSync(join(__dirname, 'samples.json'), 'utf8')) as {
  dictionary: string[]
  samples: Sample[]
}

// Fallback to the local cleanup is safe (words kept) but means the model reply was rejected.
const TARGET_MODEL_RATE = 0.9
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

describe.skipIf(!hasKey)('dictation cleanup eval (live)', () => {
  it('never changes words', { timeout: 10 * 60_000 }, async () => {
    let usd = 0
    onUsage((model, usage) => (usd += usageCost(model, usage).total))
    const rows: { s: Sample; text: string; source: string; ok: boolean; ms: number }[] = []
    for (const s of data.samples) {
      const t0 = Date.now()
      const res = await cleanupDictation(s.raw, { mode: 'light', dictionary: data.dictionary })
      rows.push({ s, ...res, ok: wordsPreserved(s.raw, res.text), ms: Date.now() - t0 })
    }
    const fallbacks = rows.filter((r) => r.source !== 'model')
    for (const r of rows)
      console.log(
        `${r.ok ? 'ok ' : 'BAD'} ${r.source.padEnd(5)} #${r.s.id} ${JSON.stringify(r.text)}`
      )
    const modelRate = 1 - fallbacks.length / rows.length
    const p50 = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
    console.log(
      `model replies kept: ${(modelRate * 100).toFixed(0)}%  p50 ${p50}ms  cost $${usd.toFixed(4)}`
    )
    expect(rows.filter((r) => !r.ok).map((r) => r.s.id)).toEqual([])
    expect(modelRate).toBeGreaterThanOrEqual(TARGET_MODEL_RATE)
  })
})
