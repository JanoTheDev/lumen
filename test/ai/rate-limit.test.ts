import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callModel } from '../../src/main/ai'
import { setProvider } from '../../src/main/ai/providers'
import { GEMINI_RATE_LIMIT_MESSAGE } from '../../src/main/ai/providers/gemini'
import { LlmError, type LlmProvider } from '../../src/main/ai/providers/types'
import { saveConfig, setConfigDir } from '../../src/main/config'

function limited(): LlmProvider {
  const fail = (): never => {
    throw new LlmError('E_RATE_LIMIT', GEMINI_RATE_LIMIT_MESSAGE)
  }
  return {
    id: 'gemini',
    // eslint-disable-next-line require-yield
    async *stream() {
      fail()
    },
    complete: async () => fail(),
    warmup: async () => {}
  }
}

describe('rate limits', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-overlay-ratelimit-'))
    setConfigDir(dir)
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('GEMINI_API_KEY', 'g-key')
    saveConfig({ models: { geminiAck: true } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    setProvider('gemini', null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a free-tier 429 becomes a spoken answer, not an error', async () => {
    setProvider('gemini', limited())
    const r = await callModel('what time is it', null, 'Explorer', { turnId: 'rl1' })
    expect(r).toMatchObject({
      mode: 'answer',
      text: 'Free tier limit reached, try again in a minute.'
    })
  })
})
