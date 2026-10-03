import { describe, expect, it, vi } from 'vitest'

const loaded = vi.hoisted(() => new Set<string>())

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/actions/policy', () => ({ gate: vi.fn() }))
vi.mock('@modelcontextprotocol/client', async (orig) => {
  loaded.add('mcp')
  return orig()
})
vi.mock('@modelcontextprotocol/client/stdio', async (orig) => {
  loaded.add('mcp-stdio')
  return orig()
})
vi.mock('openai', async (orig) => {
  loaded.add('openai')
  return orig()
})
vi.mock('@anthropic-ai/sdk', async (orig) => {
  loaded.add('anthropic')
  return orig()
})

describe('SDKs load on first use', () => {
  it('importing connectors and providers loads no SDK', async () => {
    await import('../../src/main/connectors')
    await import('../../src/main/ai/providers/anthropic')
    await import('../../src/main/ai/providers/openai')
    await import('../../src/main/ai/providers/gemini')
    await import('../../src/main/ai/providers/compatible')
    await import('../../src/main/ai/providers/local')
    expect([...loaded]).toEqual([])
    const { loadOpenAI } = await import('../../src/main/ai/providers/openai')
    await loadOpenAI()
    expect([...loaded]).toEqual(['openai'])
  })
})
