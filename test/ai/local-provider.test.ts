import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { z } from 'zod'
import {
  buildChatParams,
  createLocalProvider,
  detectLocal,
  looksVision,
  pickModel,
  resetLocalJsonLevel,
  type LocalServer
} from '../../src/main/ai/providers/local'
import { usageCost } from '../../src/main/ai/pricing'
import { onUsage, setProvider, providerFor } from '../../src/main/ai/providers'

// A fake Ollama: /api/tags, /api/show and an OpenAI-compatible /v1/chat/completions that
// replays queued replies and records the request bodies.
let server: Server
let base = ''
const bodies: Record<string, unknown>[] = []
let replies: string[] = []
let rejectSchema = false
let tags: { name: string }[] = []
const caps: Record<string, string[]> = {}

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
    if (req.url === '/api/tags') return json(res, 200, { models: tags })
    if (req.url === '/api/show') {
      const body = await readBody(req)
      const c = caps[body.model as string]
      return c ? json(res, 200, { capabilities: c }) : json(res, 404, { error: 'no' })
    }
    if (req.url === '/v1/chat/completions') {
      const body = await readBody(req)
      bodies.push(body)
      const format = body.response_format as { type?: string } | undefined
      if (rejectSchema && format?.type === 'json_schema')
        return json(res, 400, { error: { message: 'response_format json_schema not supported' } })
      const text = replies.shift() ?? '{}'
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const piece of [text.slice(0, 5), text.slice(5)]) {
          const chunk = {
            id: 'x',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        const last = {
          id: 'x',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
        }
        res.write(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)
        return res.end()
      }
      return json(res, 200, {
        id: 'x',
        object: 'chat.completion',
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      })
    }
    json(res, 404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  bodies.length = 0
  replies = []
  rejectSchema = false
  tags = []
  for (const k of Object.keys(caps)) delete caps[k]
  resetLocalJsonLevel()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const local = (over: Partial<LocalServer> = {}): LocalServer => ({
  kind: 'custom',
  baseUrl: base,
  models: ['qwen3.5:9b'],
  model: 'qwen3.5:9b',
  vision: true,
  ...over
})

const schema = z.object({ mode: z.literal('answer'), spoken: z.string() })
const req = {
  model: 'qwen3.5:9b',
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: 'hi' }],
  images: [{ base64: 'AAAA' }],
  maxTokens: 300,
  schema,
  schemaName: 'lumen_reply'
}

describe('model picking', () => {
  it('prefers a vision model, ranked by family, and skips embedding models', () => {
    const models = ['nomic-embed-text', 'llama3.1:8b', 'llama3.2-vision:11b', 'qwen2.5vl:7b']
    expect(pickModel(models, new Map())).toEqual({ model: 'qwen2.5vl:7b', vision: true })
    expect(pickModel(['llama3.1:8b'], new Map())).toEqual({ model: 'llama3.1:8b', vision: false })
    expect(pickModel(['nomic-embed-text'], new Map())).toBeNull()
  })

  it('server capabilities beat the name heuristic; a configured model wins', () => {
    const vision = new Map([
      ['mystery:7b', true],
      ['qwen2.5vl:7b', false]
    ])
    expect(pickModel(['qwen2.5vl:7b', 'mystery:7b'], vision)?.model).toBe('mystery:7b')
    expect(pickModel(['qwen2.5vl:7b', 'llama3.1:8b'], new Map(), 'llama3.1')).toEqual({
      model: 'llama3.1:8b',
      vision: false
    })
  })

  it('recognises current vision families by name', () => {
    for (const m of ['gemma3:12b', 'gemma4:12b', 'qwen3.5:4b', 'llava:7b', 'minicpm-v4.5:8b'])
      expect(looksVision(m)).toBe(true)
    for (const m of ['llama3.1:8b', 'gemma3n:e4b', 'phi4:14b']) expect(looksVision(m)).toBe(false)
  })
})

describe('detectLocal', () => {
  it('finds an Ollama-style server and asks it for capabilities', async () => {
    tags = [{ name: 'llama3.1:8b' }, { name: 'mystery:7b' }]
    caps['mystery:7b'] = ['completion', 'vision']
    caps['llama3.1:8b'] = ['completion']
    const found = await detectLocal({ url: base })
    expect(found).toMatchObject({
      kind: 'custom',
      baseUrl: base,
      model: 'mystery:7b',
      vision: true
    })
  })

  it('returns null when nothing answers or no chat model is installed', async () => {
    tags = [{ name: 'nomic-embed-text' }]
    expect(await detectLocal({ url: base })).toBeNull()
    expect(await detectLocal({ url: 'http://127.0.0.1:9' })).toBeNull()
  })
})

describe('local provider', () => {
  it('sends JSON schema mode, images as data URLs, temperature 0', () => {
    const p = buildChatParams(req, true)
    expect(p.temperature).toBe(0)
    expect(p.response_format).toMatchObject({ type: 'json_schema' })
    const user = p.messages[1] as { content: { type: string }[] }
    expect(user.content.map((c) => c.type)).toEqual(['image_url', 'text'])
    // A text-only model gets no image (the server would reject it).
    expect(buildChatParams(req, false).messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('parses a valid reply with zod', async () => {
    replies = ['Sure: {"mode":"answer","spoken":"Hello."}']
    const res = await createLocalProvider(() => local()).complete(req)
    expect(res.data).toEqual({ mode: 'answer', spoken: 'Hello.' })
    expect(res.usage.inputTokens).toBe(12)
    expect(bodies).toHaveLength(1)
  })

  it('repairs an invalid reply once by sending the validation error back', async () => {
    replies = ['{"mode":"answer"}', '{"mode":"answer","spoken":"Fixed."}']
    const res = await createLocalProvider(() => local()).complete(req)
    expect(res.data).toEqual({ mode: 'answer', spoken: 'Fixed.' })
    expect(bodies).toHaveLength(2)
    const msgs = bodies[1].messages as { role: string; content: string }[]
    expect(msgs.at(-2)).toEqual({ role: 'assistant', content: '{"mode":"answer"}' })
    expect(msgs.at(-1)?.content).toMatch(/spoken/)
    expect(res.usage.inputTokens).toBe(24)
  })

  it('gives up after one repair: data null, text kept for the tolerant parser', async () => {
    replies = ['nope', 'still nope']
    const res = await createLocalProvider(() => local()).complete(req)
    expect(res.data).toBeNull()
    expect(res.text).toBe('still nope')
    expect(bodies).toHaveLength(2)
  })

  it('falls back to json_object with the schema in the prompt when json_schema is rejected', async () => {
    rejectSchema = true
    replies = ['{"mode":"answer","spoken":"Ok."}']
    const res = await createLocalProvider(() => local()).complete(req)
    expect(res.data?.spoken).toBe('Ok.')
    const last = bodies.at(-1)!
    expect(last.response_format).toEqual({ type: 'json_object' })
    expect((last.messages as { content: string }[])[0].content).toMatch(/JSON Schema/)
  })

  it('streams text deltas and a final result with usage', async () => {
    replies = ['{"mode":"answer","spoken":"Hi there."}']
    const chunks: string[] = []
    let done: unknown
    for await (const c of createLocalProvider(() => local()).stream(req)) {
      if (c.type === 'text') chunks.push(c.text)
      else done = c.result
    }
    expect(chunks.join('')).toBe('{"mode":"answer","spoken":"Hi there."}')
    expect(done).toMatchObject({ model: 'qwen3.5:9b', usage: { inputTokens: 7, outputTokens: 3 } })
  })

  it('has no server: a clear error', async () => {
    await expect(createLocalProvider(() => null).complete(req)).rejects.toThrow(/No local model/)
  })

  it('local usage is priced at zero', async () => {
    const seen: string[] = []
    onUsage((model) => seen.push(model))
    setProvider(
      'local',
      createLocalProvider(() => local({ model: 'free-model:1b' }))
    )
    replies = ['{"mode":"answer","spoken":"x"}']
    await providerFor('local').complete({ ...req, model: 'free-model:1b' })
    expect(seen).toEqual(['free-model:1b'])
    expect(
      usageCost('free-model:1b', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }).total
    ).toBe(0)
    setProvider('local', null)
    onUsage(() => {})
  })
})
