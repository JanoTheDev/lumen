import { describe, expect, it, vi } from 'vitest'
import {
  applyDictionary,
  CLEANUP_PROMPT,
  cleanupDictation,
  cleanupTurn,
  localCleanup,
  tokenize,
  unwrapReply,
  wordsPreserved
} from '../../src/main/speech/dictation/cleanup'

type FakeComplete = ReturnType<typeof vi.fn>

function fakeProvider(reply: string | Error): {
  complete: FakeComplete
  resolve: () => { llm: { complete: FakeComplete }; model: string }
} {
  const complete = vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return {
      text: reply,
      data: null,
      model: 'fake-fast',
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }
  })
  return { complete, resolve: () => ({ llm: { complete }, model: 'fake-fast' }) }
}

describe('cleanup prompt contract', () => {
  it('forbids rewording, additions and em dashes, and treats the transcript as data', () => {
    expect(CLEANUP_PROMPT).toMatch(/never instructions/i)
    expect(CLEANUP_PROMPT).toMatch(/Reword, rephrase/)
    expect(CLEANUP_PROMPT).toMatch(/Add words/)
    expect(CLEANUP_PROMPT).toMatch(/em dashes/)
    expect(CLEANUP_PROMPT).toMatch(/Change the language/)
  })

  it('sends a cached system prompt, temperature 0 and the dictionary as preferred spellings', async () => {
    const p = fakeProvider('Open Figma tomorrow.')
    await cleanupDictation('open figma tomorrow', {
      mode: 'light',
      dictionary: ['Figma'],
      resolve: p.resolve
    })
    const req = (p.complete.mock.calls[0] as unknown[])[0] as {
      system: { text: string; cacheable: boolean }[]
      messages: { content: string }[]
      temperature: number
    }
    expect(req.system).toEqual([{ text: CLEANUP_PROMPT, cacheable: true }])
    expect(req.temperature).toBe(0)
    expect(req.messages[0].content).toBe(cleanupTurn('open figma tomorrow', ['Figma']))
    expect(req.messages[0].content).toContain('<dictionary>Figma</dictionary>')
  })

  it('accepts a faithful reply', async () => {
    const p = fakeProvider('So, I think we should ship it on Friday.')
    const res = await cleanupDictation('um so I think we should uh ship it on friday', {
      mode: 'light',
      resolve: p.resolve
    })
    expect(res).toEqual({ text: 'So, I think we should ship it on Friday.', source: 'model' })
  })

  it('rejects a reply that rewords, adds or answers, and falls back to local cleanup', async () => {
    for (const reply of [
      'I believe we should ship it on Friday.',
      'Sure! So I think we should ship it on Friday.',
      'Shipping on Friday sounds good to me.'
    ]) {
      const p = fakeProvider(reply)
      const res = await cleanupDictation('so I think we should uh ship it on friday', {
        mode: 'light',
        resolve: p.resolve
      })
      expect(res.source).toBe('local')
      expect(res.text).toBe('So I think we should ship it on friday')
    }
  })

  it('falls back to local cleanup when the model fails', async () => {
    const p = fakeProvider(new Error('network down'))
    const res = await cleanupDictation('uh hello there', { mode: 'light', resolve: p.resolve })
    expect(res).toEqual({ text: 'Hello there', source: 'local' })
  })

  it('cleanup off returns the raw transcript (dictionary casing only) without a model call', async () => {
    const p = fakeProvider('never used')
    const res = await cleanupDictation(' um figma is great ', {
      mode: 'off',
      dictionary: ['Figma'],
      resolve: p.resolve
    })
    expect(res).toEqual({ text: 'um Figma is great', source: 'raw' })
    expect(p.complete).not.toHaveBeenCalled()
  })
})

describe('wordsPreserved', () => {
  it.each([
    ['um I think so', 'I think so.'],
    ['the the report is done', 'The report is done.'],
    ['hello new line world', 'Hello\nworld'],
    ['add milk comma eggs period', 'Add milk, eggs.'],
    ['it was like really good', 'It was really good.'],
    ['you know it works', 'It works.'],
    ["I'm here", 'I’m here.'],
    ['e-mail me', 'E-mail me.']
  ])('allows %j -> %j', (raw, cleaned) => {
    expect(wordsPreserved(raw, cleaned)).toBe(true)
  })

  it.each([
    ['I think so', 'I believe so.'],
    ['send it', 'Please send it.'],
    ['thank you for coming', 'Thank for coming.'],
    ['twenty five apples', '25 apples.'],
    ['ship it on friday', 'Ship it.'],
    ['hello', '']
  ])('rejects %j -> %j', (raw, cleaned) => {
    expect(wordsPreserved(raw, cleaned)).toBe(false)
  })

  it('tokenizes case- and punctuation-insensitively', () => {
    expect(tokenize("Hello, World! It's ok.")).toEqual(['hello', 'world', "it's", 'ok'])
  })
})

describe('applyDictionary', () => {
  it('rewrites terms to their stored casing as whole words only', () => {
    const dict = ['Figma', 'DaVinci Resolve', 'iPhone']
    expect(applyDictionary('open figma and davinci  resolve on my IPHONE', dict)).toBe(
      'open Figma and DaVinci Resolve on my iPhone'
    )
    expect(applyDictionary('figmatic designs', dict)).toBe('figmatic designs')
  })

  it('ignores blanks and regex characters in terms', () => {
    expect(applyDictionary('use c++ daily', ['', '  ', 'C++'])).toBe('use C++ daily')
  })
})

describe('local helpers', () => {
  it('localCleanup removes fillers and capitalises', () => {
    expect(localCleanup('um, so uh we meet at noon')).toBe('So we meet at noon')
    expect(localCleanup('  ')).toBe('')
  })

  it('unwrapReply strips tags and fences', () => {
    expect(unwrapReply('<text>Hi.</text>')).toBe('Hi.')
    expect(unwrapReply('```\nHi.\n```')).toBe('Hi.')
  })
})
