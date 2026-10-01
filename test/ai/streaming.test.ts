import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { SentenceSplitter } from '../../src/main/ai/sentences'
import { readPartialString } from '../../src/main/ai/json'
import { streamReply } from '../../src/main/ai/stream-reply'
import { callModel } from '../../src/main/ai'
import { setProvider } from '../../src/main/ai/providers'
import type { ChatChunk, LlmProvider } from '../../src/main/ai/providers/types'
import { bus } from '../../src/main/bus'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeProvider(pieces: string[], delayMs = 0): LlmProvider {
  return {
    id: 'anthropic',
    async *stream(_req, signal): AsyncIterable<ChatChunk> {
      for (const text of pieces) {
        if (delayMs) await sleep(delayMs)
        if (signal?.aborted) return
        yield { type: 'text', text }
      }
      yield {
        type: 'done',
        result: {
          text: pieces.join(''),
          model: 'claude-sonnet-5-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      }
    },
    complete: vi.fn(),
    warmup: async () => {}
  }
}

function listen(): {
  deltas: string[]
  chunks: { text: string; index: number; at: number }[]
  off: () => void
} {
  const deltas: string[] = []
  const chunks: { text: string; index: number; at: number }[] = []
  const offs = [
    bus.on('query.delta', (e) => deltas.push(e.delta)),
    bus.on('speech.say-chunk', (e) =>
      chunks.push({ text: e.text, index: e.index, at: performance.now() })
    )
  ]
  return { deltas, chunks, off: () => offs.forEach((o) => o()) }
}

// A reply streamed in small pieces, with escapes and a sentence split across chunks.
const REPLY =
  '{"response":{"mode":"answer","spoken":"It\'s 4 p.m. in Tokyo. Dr. Lee said \\"hi\\" twice!","markdown":"**4 PM**"}}'
const PIECES = REPLY.match(/.{1,7}/gs)!

describe('SentenceSplitter', () => {
  it('splits on sentence ends followed by whitespace', () => {
    const s = new SentenceSplitter()
    expect(s.push('Hello there. How')).toEqual(['Hello there.'])
    expect(s.push(' are you? Fine')).toEqual(['How are you?'])
    expect(s.flush()).toBe('Fine')
    expect(s.flush()).toBeNull()
  })

  it('keeps decimals, abbreviations and initials inside a sentence', () => {
    const s = new SentenceSplitter()
    expect(s.push('Version 3.5 is out, e.g. on Windows. Ask Dr. Smith or J. Doe. ')).toEqual([
      'Version 3.5 is out, e.g. on Windows.',
      'Ask Dr. Smith or J. Doe.'
    ])
  })

  it('treats closing quotes and newlines as part of the boundary', () => {
    const s = new SentenceSplitter()
    expect(s.push('He said "stop." Then left\nNext')).toEqual(['He said "stop."', 'Then left'])
  })
})

describe('readPartialString', () => {
  it('reads a value that is still being written', () => {
    expect(readPartialString('{"mode":"answer"', 'spoken')).toBeNull()
    expect(readPartialString('{"spoken": "Hel', 'spoken')).toEqual({ text: 'Hel', done: false })
    expect(readPartialString('{"spoken":"a\\"b\\n', 'spoken')).toEqual({
      text: 'a"b\n',
      done: false
    })
    expect(readPartialString('{"spoken":"x\\', 'spoken')).toEqual({ text: 'x', done: false })
    expect(readPartialString('{"spoken":"\\u00e9\\u00', 'spoken')).toEqual({
      text: 'é',
      done: false
    })
    expect(readPartialString('{"spoken":"done","markdown":"no"}', 'spoken')).toEqual({
      text: 'done',
      done: true
    })
  })
})

describe('streamReply', () => {
  let l: ReturnType<typeof listen>
  beforeEach(() => (l = listen()))
  afterEach(() => l.off())

  const req = { model: 'm', system: [], messages: [], maxTokens: 100 }

  it('publishes the spoken text as deltas and sentence chunks', async () => {
    const res = await streamReply(fakeProvider(PIECES), req, undefined, 't1')
    expect(res.text).toBe(REPLY)
    expect(l.deltas.join('')).toBe('It\'s 4 p.m. in Tokyo. Dr. Lee said "hi" twice!')
    expect(l.chunks.map((c) => c.text)).toEqual([
      "It's 4 p.m. in Tokyo.",
      'Dr. Lee said "hi" twice!'
    ])
    expect(l.chunks.map((c) => c.index)).toEqual([0, 1])
  })

  it('emits the first speech chunk within 300ms of the first token', async () => {
    const pieces = [
      '{"response":{"mode":"answer","spoken":"',
      'Open',
      ' Settings',
      '. Then',
      ' x."}}'
    ]
    let firstToken = 0
    const provider = fakeProvider(pieces, 40)
    const stream = provider.stream.bind(provider)
    provider.stream = async function* (r, s) {
      for await (const c of stream(r, s)) {
        if (!firstToken) firstToken = performance.now()
        yield c
      }
    }
    await streamReply(provider, req, undefined, 't2')
    expect(l.chunks[0].text).toBe('Open Settings.')
    expect(l.chunks[0].at - firstToken).toBeLessThanOrEqual(300)
  })

  it('publishes nothing without a turn id or for non-answer replies', async () => {
    await streamReply(fakeProvider(PIECES), req)
    await streamReply(
      fakeProvider([
        '{"response":{"mode":"action","summary":"Open it","risk":"low","actions":[]}}'
      ]),
      req,
      undefined,
      't3'
    )
    expect(l.deltas).toEqual([])
    expect(l.chunks).toEqual([])
  })

  it('stops publishing and throws on abort', async () => {
    const ctrl = new AbortController()
    const p = streamReply(fakeProvider(PIECES, 5), req, ctrl.signal, 't4')
    await sleep(12)
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    const seen = l.deltas.length
    await sleep(30)
    expect(l.deltas.length).toBe(seen)
  })
})

describe('callModel streaming', () => {
  const key = process.env.ANTHROPIC_API_KEY
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    setProvider('anthropic', null)
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  it('streams the answer and returns the parsed reply', async () => {
    setProvider('anthropic', fakeProvider(PIECES))
    const l = listen()
    const r = await callModel('what time is it in Tokyo', null, 'Explorer', { turnId: 't5' })
    l.off()
    expect(r).toMatchObject({ mode: 'answer', text: '**4 PM**', spoken: expect.any(String) })
    expect(l.chunks).toHaveLength(2)
  })
})
