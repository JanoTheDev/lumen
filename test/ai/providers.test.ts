import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { z } from 'zod'
import {
  buildParams as anthropicParams,
  createAnthropicProvider
} from '../../src/main/ai/providers/anthropic'
import {
  buildParams as openaiParams,
  createOpenAIProvider
} from '../../src/main/ai/providers/openai'
import {
  LlmError,
  type ChatChunk,
  type ChatRequest,
  type LlmProvider
} from '../../src/main/ai/providers/types'

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'claude-sonnet-5-5',
  system: [
    { text: 'stable', cacheable: true },
    { text: 'volatile', cacheable: false }
  ],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
  ...over
})

function anthropicMessage(
  text: string,
  stop: string,
  usage: Partial<Anthropic.Usage> = {}
): object {
  return {
    model: 'claude-sonnet-5-5',
    stop_reason: stop,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5, ...usage }
  }
}

async function* events<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('anthropic params', () => {
  it('marks only cacheable system blocks and attaches images to the last user turn', () => {
    const p = anthropicParams(req({ images: [{ base64: 'AAA' }] }))
    const system = p.system as Anthropic.TextBlockParam[]
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1].cache_control).toBeUndefined()
    const content = p.messages[0].content as Anthropic.ContentBlockParam[]
    expect(content[0].type).toBe('image')
    expect(content[1]).toEqual({ type: 'text', text: 'hi' })
  })

  it('never sends temperature or disabled thinking to Sonnet 5.5', () => {
    const p = anthropicParams(req({ temperature: 0, effort: 'low' }))
    expect(p.temperature).toBeUndefined()
    expect(p.thinking).toEqual({ type: 'between_tools' })
    expect(p.output_config).toEqual({ effort: 'low' })
  })

  it('leaves thinking alone on Opus 5.5 and drops effort on Haiku 4.5', () => {
    expect(
      anthropicParams(req({ model: 'claude-opus-5-5', effort: 'low' })).thinking
    ).toBeUndefined()
    const haiku = anthropicParams(req({ model: 'claude-haiku-4-5', effort: 'low', temperature: 0 }))
    expect(haiku.output_config).toBeUndefined()
    expect(haiku.thinking).toBeUndefined()
    expect(haiku.temperature).toBe(0)
  })

  it('omits an empty system prompt', () => {
    expect(anthropicParams(req({ system: [] })).system).toBeUndefined()
  })
})

describe('anthropic provider', () => {
  function fake(
    create: (...a: unknown[]) => unknown,
    parse?: (...a: unknown[]) => unknown
  ): { client: { messages: { create: Mock; parse: Mock } }; provider: LlmProvider } {
    const client = { messages: { create: vi.fn(create), parse: vi.fn(parse) } }
    return { client, provider: createAnthropicProvider(() => client as unknown as Anthropic) }
  }

  it('assembles a streamed reply', async () => {
    const { provider } = fake(async () =>
      events([
        {
          type: 'message_start',
          message: {
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 3 }
          }
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }
      ])
    )
    const chunks = await collect(provider.stream(req()))
    expect(chunks.slice(0, 2)).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' }
    ])
    expect(chunks[2]).toEqual({
      type: 'done',
      result: {
        text: 'Hello',
        model: 'claude-sonnet-5-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 }
      }
    })
  })

  it('passes the signal and emits nothing after an abort', async () => {
    const ctrl = new AbortController()
    const { client, provider } = fake(async () =>
      events([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
      ])
    )
    const seen: ChatChunk[] = []
    for await (const c of provider.stream(req(), ctrl.signal)) {
      seen.push(c)
      ctrl.abort()
    }
    expect(seen).toEqual([{ type: 'text', text: 'a' }])
    expect(client.messages.create.mock.calls[0][1]).toEqual({ signal: ctrl.signal })
  })

  it('retries once with double max_tokens after truncation', async () => {
    const replies = [
      anthropicMessage('{"a":', 'max_tokens'),
      anthropicMessage('{"a":1}', 'end_turn')
    ]
    const { client, provider } = fake(async () => replies.shift())
    const res = await provider.complete(req({ maxTokens: 3000 }))
    expect(res.text).toBe('{"a":1}')
    expect(res.usage.inputTokens).toBe(20)
    const second = client.messages.create.mock.calls[1][0] as { max_tokens: number }
    expect(second.max_tokens).toBe(6000)
  })

  it('caps the retry at 8k and reports E_TRUNCATED', async () => {
    const { client, provider } = fake(async () => anthropicMessage('x', 'max_tokens'))
    await expect(provider.complete(req({ maxTokens: 6000 }))).rejects.toMatchObject({
      code: 'E_TRUNCATED'
    })
    expect((client.messages.create.mock.calls[1][0] as { max_tokens: number }).max_tokens).toBe(
      8192
    )
    client.messages.create.mockClear()
    await expect(provider.complete(req({ maxTokens: 8192 }))).rejects.toBeInstanceOf(LlmError)
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })

  it('turns a refusal into a friendly error', async () => {
    const { provider } = fake(async () => anthropicMessage('', 'refusal'))
    await expect(provider.complete(req())).rejects.toMatchObject({ code: 'E_REFUSED' })
  })

  it('returns parsed data when a schema is given', async () => {
    const { client, provider } = fake(
      async () => null,
      async () => ({ ...anthropicMessage('{"n":2}', 'end_turn'), parsed_output: { n: 2 } })
    )
    const res = await provider.complete({ ...req(), schema: z.object({ n: z.number() }) })
    expect(res.data).toEqual({ n: 2 })
    const body = client.messages.parse.mock.calls[0][0] as { output_config: { format: unknown } }
    expect(body.output_config.format).toBeTruthy()
  })
})

describe('openai params', () => {
  it('sends minimal reasoning to gpt-5-mini and none to gpt-4o', () => {
    expect(openaiParams(req({ model: 'gpt-5-mini', effort: 'low' })).reasoning).toEqual({
      effort: 'minimal'
    })
    const p = openaiParams(req({ model: 'gpt-4o', effort: 'low', temperature: 0.2 }))
    expect(p.reasoning).toBeUndefined()
    expect(p.temperature).toBe(0.2)
    expect(openaiParams(req({ model: 'gpt-5.4', effort: 'low' })).reasoning).toEqual({
      effort: 'low'
    })
  })

  it('puts images before the text of the last user message', () => {
    const p = openaiParams(req({ model: 'gpt-5-mini', images: [{ base64: 'AAA', detail: 'low' }] }))
    const msg = (p.input as OpenAI.Responses.EasyInputMessage[])[0]
    expect(msg.content).toEqual([
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'low' },
      { type: 'input_text', text: 'hi' }
    ])
    expect(p.instructions).toBe('stable\n\nvolatile')
  })
})

describe('openai provider', () => {
  const response = (text: string, status = 'completed', reason?: string): object => ({
    model: 'gpt-5-mini',
    status,
    incomplete_details: reason ? { reason } : null,
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } }
  })

  function fake(create: (...a: unknown[]) => unknown): {
    client: { responses: { create: Mock; parse: Mock } }
    provider: LlmProvider
  } {
    const client = { responses: { create: vi.fn(create), parse: vi.fn() } }
    return { client, provider: createOpenAIProvider(() => client as unknown as OpenAI) }
  }

  it('splits cached input tokens out of the usage', async () => {
    const { provider } = fake(async () => response('ok'))
    const res = await provider.complete(req({ model: 'gpt-5-mini' }))
    expect(res.usage).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 0
    })
  })

  it('retries a truncated reply once', async () => {
    const replies = [response('', 'incomplete', 'max_output_tokens'), response('done')]
    const { client, provider } = fake(async () => replies.shift())
    const res = await provider.complete(req({ model: 'gpt-5-mini', maxTokens: 2048 }))
    expect(res.text).toBe('done')
    expect(
      (client.responses.create.mock.calls[1][0] as { max_output_tokens: number }).max_output_tokens
    ).toBe(4096)
  })

  it('assembles a streamed reply and stops after abort', async () => {
    const stream = [
      { type: 'response.output_text.delta', delta: 'x' },
      { type: 'response.output_text.delta', delta: 'y' },
      { type: 'response.completed', response: response('xy') }
    ]
    const { provider } = fake(async () => events(stream))
    const chunks = await collect(provider.stream(req({ model: 'gpt-5-mini' })))
    expect(chunks.map((c) => c.type)).toEqual(['text', 'text', 'done'])
    expect(chunks[2].type === 'done' && chunks[2].result.text).toBe('xy')

    const ctrl = new AbortController()
    const { provider: p2 } = fake(async () => events(stream))
    const seen: ChatChunk[] = []
    for await (const c of p2.stream(req({ model: 'gpt-5-mini' }), ctrl.signal)) {
      seen.push(c)
      ctrl.abort()
    }
    expect(seen).toHaveLength(1)
  })
})
