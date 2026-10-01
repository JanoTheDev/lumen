import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import OpenAI from 'openai'
import { z } from 'zod'
import { createGeminiProvider, GEMINI_RATE_LIMIT_MESSAGE } from '../../src/main/ai/providers/gemini'
import { createCompatibleProvider, parseModelList } from '../../src/main/ai/providers/compatible'
import { resetJsonLevels } from '../../src/main/ai/providers/chat-completions'
import { LlmError, type AgentMessage, type ToolDef } from '../../src/main/ai/providers/types'

// A fake OpenAI-compatible chat-completions server: replays queued replies (or a status) and
// records request bodies. No live calls.
let server: Server
let base = ''
const bodies: Record<string, unknown>[] = []
let queue: { status?: number; message?: Record<string, unknown>; finish?: string }[] = []

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      const body = await readBody(req)
      bodies.push(body)
      const next = queue.shift() ?? { message: { role: 'assistant', content: '{}' } }
      if (next.status) return json(res, next.status, { error: { message: 'quota exceeded' } })
      return json(res, 200, {
        id: 'x',
        object: 'chat.completion',
        model: `models/${body.model as string}`,
        choices: [{ index: 0, message: next.message, finish_reason: next.finish ?? 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    }
    json(res, 404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  bodies.length = 0
  queue = []
  resetJsonLevels()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const client = (): OpenAI => new OpenAI({ apiKey: 'test', baseURL: base, maxRetries: 0 })

const schema = z.object({ mode: z.literal('answer'), spoken: z.string() })
const req = {
  model: 'gemini-3.8-flash',
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: 'hi' }],
  images: [{ base64: 'AAAA' }],
  maxTokens: 300,
  effort: 'low' as const,
  schema,
  schemaName: 'lumen_reply'
}

describe('gemini provider', () => {
  it('sends JSON schema, the image and reasoning_effort; strips "models/" from the id', async () => {
    queue = [{ message: { role: 'assistant', content: '{"mode":"answer","spoken":"Hi."}' } }]
    const res = await createGeminiProvider(client).complete(req)
    expect(res.data).toEqual({ mode: 'answer', spoken: 'Hi.' })
    expect(res.model).toBe('gemini-3.8-flash')
    const body = bodies[0]
    expect(body.reasoning_effort).toBe('low')
    expect(body.temperature).toBeUndefined()
    expect(body.response_format).toMatchObject({ type: 'json_schema' })
    const user = (body.messages as { content: { type: string }[] }[])[1]
    expect(user.content.map((c) => c.type)).toEqual(['image_url', 'text'])
  })

  it('turns a 429 into a spoken free-tier message', async () => {
    queue = [{ status: 429 }]
    const err = await createGeminiProvider(client)
      .complete(req)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe('E_RATE_LIMIT')
    expect((err as LlmError).message).toBe(GEMINI_RATE_LIMIT_MESSAGE)
  })

  it('reports vision and tools for every model', () => {
    const p = createGeminiProvider(client)
    expect(p.supportsVision('gemini-3.5-flash-lite')).toBe(true)
    expect(p.supportsTools('gemini-3.5-flash-lite')).toBe(true)
  })
})

const tools: ToolDef[] = [
  {
    name: 'act',
    description: 'Click something.',
    schema: z.object({ target: z.string(), times: z.number().optional() })
  }
]

describe('tool turns over chat completions', () => {
  it('sends tools, parses calls and keeps provider extras for the next turn', async () => {
    const call = {
      id: 'call_1',
      type: 'function',
      function: { name: 'act', arguments: '{"target":"OK","times":null}' },
      extra_content: { google: { thought_signature: 'sig-1' } }
    }
    queue = [
      { message: { role: 'assistant', content: null, tool_calls: [call] }, finish: 'tool_calls' },
      { message: { role: 'assistant', content: 'Done.' } }
    ]
    const p = createGeminiProvider(client)
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'click ok' }] }
    ]
    const first = await p.toolTurn!({
      model: 'gemini-3.8-flash',
      system: [{ text: 'sys', cacheable: true }],
      tools,
      messages,
      maxTokens: 500
    })
    expect(first.stopReason).toBe('tool_use')
    expect(first.message.calls).toEqual([{ id: 'call_1', name: 'act', input: { target: 'OK' } }])
    const sentTools = bodies[0].tools as {
      type: string
      function: { name: string; parameters: { properties: object } }
    }[]
    expect(sentTools[0].function.name).toBe('act')
    expect(Object.keys(sentTools[0].function.parameters.properties)).toEqual(['target', 'times'])

    messages.push(first.message, {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'call_1',
          content: [
            { type: 'text', text: 'clicked' },
            { type: 'image', base64: 'BBBB' }
          ]
        }
      ]
    })
    const second = await p.toolTurn!({
      model: 'gemini-3.8-flash',
      system: [{ text: 'sys', cacheable: true }],
      tools,
      messages,
      maxTokens: 500
    })
    expect(second.message.text).toBe('Done.')
    expect(second.stopReason).toBe('end_turn')
    const sent = bodies[1].messages as Record<string, unknown>[]
    const assistant = sent.find((m) => m.role === 'assistant') as { tool_calls: (typeof call)[] }
    expect(assistant.tool_calls[0].extra_content).toEqual(call.extra_content)
    expect(sent.find((m) => m.role === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'clicked'
    })
    // The screenshot from the tool result follows as a user message.
    const last = sent.at(-1) as { role: string; content: { type: string }[] }
    expect(last.role).toBe('user')
    expect(last.content.map((c) => c.type)).toEqual(['text', 'image_url'])
  })
})

describe('OpenAI-compatible service', () => {
  it('reads vision and tool support from an OpenRouter-style model list', () => {
    const list = parseModelList({
      data: [
        {
          id: 'vendor/seeing-model',
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['tools', 'temperature']
        },
        {
          id: 'vendor/text-model',
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['temperature']
        },
        { id: 'llama-3.3-70b-versatile' }
      ]
    })
    expect(list).toEqual([
      { id: 'vendor/seeing-model', vision: true, tools: true },
      { id: 'vendor/text-model', vision: false, tools: false },
      { id: 'llama-3.3-70b-versatile', vision: false, tools: true }
    ])
    expect(parseModelList({ nope: 1 })).toEqual([])
  })

  it('a 429 from the service is a spoken rate-limit error too', async () => {
    queue = [{ status: 429 }]
    const err = await createCompatibleProvider(client)
      .complete({ ...req, model: 'some-model' })
      .catch((e: unknown) => e)
    expect((err as LlmError).code).toBe('E_RATE_LIMIT')
    expect((err as LlmError).message).toMatch(/try again in a minute/i)
  })
})
