import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { bus } from '../src/main/bus'
import { setConfigDir } from '../src/main/config'
import * as assistant from '../src/main/windows/assistant'
import { tempDir } from './helpers/fixtures'

const card = { summary: 'Click Send', risk: 'low' as const }

describe('assistant confirm deny', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    vi.useFakeTimers()
    tmp = tempDir()
    setConfigDir(tmp.dir)
    assistant.consumeDenied()
  })
  afterEach(() => {
    assistant.close()
    assistant.consumeDenied()
    vi.useRealTimers()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('a denied explain-before-do confirm skips the execute that follows once', async () => {
    const answer = assistant.requestConfirm(card, { gatesExecute: true })
    assistant.command({ type: 'deny' })
    expect(await answer).toBe(false)
    expect(assistant.consumeDenied()).toBe(true)
    expect(assistant.consumeDenied()).toBe(false)
  })

  it('a confirm that does not gate execution (lesson offer) never skips one', async () => {
    const answer = assistant.requestConfirm(card)
    assistant.close()
    expect(await answer).toBe(false)
    expect(assistant.consumeDenied()).toBe(false)
  })

  it('a deny does not carry over into the next turn', async () => {
    const answer = assistant.requestConfirm(card, { gatesExecute: true })
    assistant.close()
    await answer
    bus.emit({ type: 'query.started', turnId: 't2', prompt: 'next' })
    expect(assistant.consumeDenied()).toBe(false)
  })
})
