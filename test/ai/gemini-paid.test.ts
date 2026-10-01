import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { providerFor, setProvider } from '../../src/main/ai/providers'
import { usageCost } from '../../src/main/ai/pricing'
import { EMPTY_USAGE, type LlmProvider } from '../../src/main/ai/providers/types'
import { saveConfig, setConfigDir } from '../../src/main/config'

let dir: string

const usage = { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 }

function fake(model: string): LlmProvider {
  return {
    id: 'gemini',
    complete: async () => ({ data: null, text: 'ok', usage, model, stopReason: 'stop' }),
    stream: async function* () {
      yield* []
    },
    warmup: async () => {}
  } as unknown as LlmProvider
}

async function call(model: string): Promise<void> {
  setProvider('gemini', fake(model))
  await providerFor('gemini').complete({ model, system: [], messages: [], maxTokens: 10 })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-gemini-paid-'))
  setConfigDir(dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  setProvider('gemini', null)
  vi.restoreAllMocks()
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('Gemini cost', () => {
  it('free tier costs nothing; a key with billing on counts at the paid rate', async () => {
    await call('gemini-3.8-flash')
    expect(usageCost('gemini-3.8-flash', usage).total).toBe(0)
    saveConfig({ models: { geminiPaid: true } })
    await call('gemini-3.8-flash')
    expect(usageCost('gemini-3.8-flash', usage).total).toBe(4.5)
  })
})
