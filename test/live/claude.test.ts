/**
 * Run: npm run test:live (needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env).
 * Calls the real model through callModel: structured reply, schema adapter and provider.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import 'dotenv/config'
import { callModel } from '../../src/main/ai'

const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

describe.skipIf(!hasKey)('live model reply', () => {
  it('answers a plain question with a short spoken reply', async () => {
    const r = await callModel('What is two plus two?', null, 'File Explorer')
    expect(r.mode).toBe('answer')
    if (r.mode !== 'answer') return
    expect(r.spoken).toMatch(/4|four/i)
    expect(r.spoken!.split(/[.!?](\s|$)/).filter((s) => s?.trim()).length).toBeLessThanOrEqual(2)
    expect(r.text).toBeTruthy()
  }, 30_000)

  it('opens a named site with an open_url action', async () => {
    const r = await callModel('open youtube', null, 'File Explorer')
    expect(r.mode).toBe('action')
    if (r.mode !== 'action') return
    expect(r.actions[0]).toMatchObject({ type: 'open_url' })
    expect(r.risk).toBeDefined()
  }, 30_000)
})
