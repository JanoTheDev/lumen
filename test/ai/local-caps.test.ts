import { describe, it, expect } from 'vitest'
import { detectLocal, pickModel } from '../../src/main/ai/providers/local'

// Fake fetch per URL path; anything else is "not running".
function fakeFetch(routes: Record<string, (body: unknown) => unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]
    if (!route) return new Response('{}', { status: 404 })
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response(JSON.stringify(route(body)), { status: 200 })
  }) as typeof fetch
}

describe('local model capabilities', () => {
  it('Ollama: reads vision and tools per model from /api/show', async () => {
    const caps: Record<string, string[]> = {
      'gemma3:12b': ['completion', 'vision'],
      'qwen3.5:9b': ['completion', 'vision', 'tools', 'thinking'],
      'llama3.1:8b': ['completion', 'tools']
    }
    const found = await detectLocal({
      url: 'http://localhost:11434',
      fetch: fakeFetch({
        '/api/tags': () => ({ models: Object.keys(caps).map((name) => ({ name })) }),
        '/api/show': (b) => ({ capabilities: caps[(b as { model: string }).model] })
      })
    })
    // A vision model with tool use beats a higher-ranked one without.
    expect(found).toMatchObject({ model: 'qwen3.5:9b', vision: true, tools: true })
    expect(found?.info).toEqual({
      'gemma3:12b': { vision: true, tools: false },
      'qwen3.5:9b': { vision: true, tools: true },
      'llama3.1:8b': { vision: false, tools: true }
    })
  })

  it('LM Studio: reads capabilities from /api/v1/models', async () => {
    const found = await detectLocal({
      url: 'http://localhost:1234',
      fetch: fakeFetch({
        '/v1/models': () => ({ data: [{ id: 'google/gemma-4-26b-a4b' }, { id: 'text-only-7b' }] }),
        '/api/v1/models': () => ({
          models: [
            {
              key: 'google/gemma-4-26b-a4b',
              type: 'llm',
              capabilities: { vision: true, trained_for_tool_use: true }
            },
            {
              key: 'text-only-7b',
              type: 'llm',
              capabilities: { vision: false, trained_for_tool_use: false }
            }
          ]
        })
      })
    })
    expect(found).toMatchObject({
      kind: 'custom',
      model: 'google/gemma-4-26b-a4b',
      vision: true,
      tools: true
    })
    expect(found?.info?.['text-only-7b']).toEqual({ vision: false, tools: false })
  })

  it('without vision models, a model with tool use is picked first', () => {
    const tools = new Map([['llama3.1:8b', true]])
    expect(pickModel(['phi4:14b', 'llama3.1:8b'], new Map(), undefined, tools)).toEqual({
      model: 'llama3.1:8b',
      vision: false
    })
  })
})
