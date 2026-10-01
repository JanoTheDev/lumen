import { describe, expect, it, vi } from 'vitest'
import {
  autoDictateGate,
  classifyUtterance,
  isConfidentDictation,
  looksLikeRequest
} from '../../src/main/speech/dictation/autodetect'
import type { FocusTarget } from '../../src/main/speech/dictation/terminal-guard'

const field: FocusTarget = {
  process: 'slack.exe',
  title: 'Slack',
  uia: true,
  role: 'edit',
  name: 'Message #general',
  editable: true,
  password: false,
  valueTail: ''
}
const on = { enabled: true, autoDetect: true }
const content = 'I will be about ten minutes late to the standup today'

describe('auto-detect gating', () => {
  it.each([
    'what is the weather in Paris today',
    'open my third email please now',
    'rewrite this paragraph to sound friendlier',
    'write a reply saying I will be late',
    'can you summarize this page for me',
    'Is the meeting still on for tomorrow?',
    'scroll down',
    'hey lumen open spotify and play music'
  ])('treats %j as a request', (u) => {
    expect(looksLikeRequest(u)).toBe(true)
    expect(autoDictateGate(u, on, field)).toBe(false)
  })

  it.each([
    content,
    'Thanks for the update, the numbers look good to me',
    'The quarterly report shows growth in every region'
  ])('lets %j through to the model check', (u) => {
    expect(looksLikeRequest(u)).toBe(false)
    expect(autoDictateGate(u, on, field)).toBe(true)
  })

  it('needs an editable, non-password field read through UI Automation', () => {
    expect(autoDictateGate(content, on, null)).toBe(false)
    expect(autoDictateGate(content, on, { ...field, editable: false })).toBe(false)
    expect(autoDictateGate(content, on, { ...field, password: true })).toBe(false)
    expect(autoDictateGate(content, on, { ...field, uia: false })).toBe(false)
  })

  it('respects the settings', () => {
    expect(autoDictateGate(content, { enabled: true, autoDetect: false }, field)).toBe(false)
    expect(autoDictateGate(content, { enabled: false, autoDetect: true }, field)).toBe(false)
  })
})

describe('auto-detect model check', () => {
  function provider(reply: unknown): {
    complete: ReturnType<typeof vi.fn>
    resolve: () => { llm: { complete: ReturnType<typeof vi.fn> }; model: string }
  } {
    const complete = vi.fn(async () => {
      if (reply instanceof Error) throw reply
      return {
        text: JSON.stringify(reply),
        data: reply,
        model: 'fake',
        stopReason: 'end',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
    })
    return { complete, resolve: () => ({ llm: { complete }, model: 'fake' }) }
  }

  it('only a confident dictation verdict (>= 0.8) dictates', async () => {
    for (const [reply, expected] of [
      [{ kind: 'dictation', confidence: 0.92 }, true],
      [{ kind: 'dictation', confidence: 0.79 }, false],
      [{ kind: 'request', confidence: 0.99 }, false]
    ] as const) {
      const p = provider(reply)
      const verdict = await classifyUtterance(content, field, { resolve: p.resolve })
      expect(isConfidentDictation(verdict)).toBe(expected)
    }
  })

  it('a failed check never dictates', async () => {
    const p = provider(new Error('timeout'))
    const verdict = await classifyUtterance(content, field, { resolve: p.resolve })
    expect(verdict).toBeNull()
    expect(isConfidentDictation(verdict)).toBe(false)
  })

  it('sends the app and field as context and the utterance as data', async () => {
    const p = provider({ kind: 'request', confidence: 0.5 })
    await classifyUtterance(content, field, { resolve: p.resolve })
    const req = (p.complete.mock.calls[0] as unknown[])[0] as {
      messages: { content: string }[]
      temperature: number
    }
    expect(req.temperature).toBe(0)
    expect(req.messages[0].content).toContain('app: slack.exe')
    expect(req.messages[0].content).toContain(`<utterance>${content}</utterance>`)
  })
})
