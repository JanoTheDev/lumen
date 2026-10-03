import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentMessage,
  ChatChunk,
  CompleteResult,
  LlmProvider,
  StructuredRequest,
  ToolTurnRequest,
  ToolTurnResult
} from '../../src/main/ai/providers/types'

const calls = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../src/main/actions/redact', async (orig) => {
  const real = await orig<typeof import('../../src/main/actions/redact')>()
  return {
    ...real,
    redactForModel: (text: string) => {
      calls.n++
      return real.redactForModel(text)
    }
  }
})

const { providerFor, setProvider } = await import('../../src/main/ai/providers')

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
// Built from pieces so no committed literal looks like a real key to secret scanners.
const KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')

function recorder(): { provider: LlmProvider; seen: ToolTurnRequest[] } {
  const seen: ToolTurnRequest[] = []
  const provider: LlmProvider = {
    id: 'anthropic',
    async *stream(req): AsyncIterable<ChatChunk> {
      yield {
        type: 'done',
        result: { text: '', usage: USAGE, model: req.model, stopReason: 'end_turn' }
      }
    },
    complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => ({
      text: '',
      data: null,
      usage: USAGE,
      model: req.model,
      stopReason: 'end_turn'
    }),
    toolTurn: async (req: ToolTurnRequest): Promise<ToolTurnResult> => {
      seen.push(req)
      return {
        message: { role: 'assistant', text: '', calls: [] },
        usage: USAGE,
        model: req.model,
        stopReason: 'end_turn'
      }
    },
    warmup: async () => {}
  }
  return { provider, seen }
}

const turn = (messages: AgentMessage[]): ToolTurnRequest => ({
  model: 'claude-test',
  system: [{ text: 'sys', cacheable: true }],
  messages,
  tools: [],
  maxTokens: 100
})

describe('agent message redaction memo', () => {
  afterEach(() => {
    setProvider('anthropic', null)
    calls.n = 0
  })

  it('redacts each message once across turns and reuses the same redacted object', async () => {
    const { provider, seen } = recorder()
    setProvider('anthropic', provider)
    const llm = providerFor('anthropic')
    const m1: AgentMessage = { role: 'user', content: [{ type: 'text', text: `go ${KEY}` }] }
    const m2: AgentMessage = { role: 'assistant', text: `using ${KEY}`, calls: [] }
    const m3: AgentMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', id: 't1', content: [{ type: 'text', text: `found ${KEY}` }] }
      ]
    }
    calls.n = 0
    await llm.toolTurn!(turn([m1]))
    await llm.toolTurn!(turn([m1, m2]))
    await llm.toolTurn!(turn([m1, m2, m3]))
    expect(calls.n).toBe(3)
    expect(seen[1].messages[0]).toBe(seen[0].messages[0])
    expect(seen[2].messages[1]).toBe(seen[1].messages[1])
    const sent = JSON.stringify(seen[2].messages)
    expect(sent).not.toContain(KEY)
    expect(sent.match(/\[redacted/g)?.length).toBe(3)
    expect(m1.content[0]).toEqual({ type: 'text', text: `go ${KEY}` })
  })

  it('redacts a new message object even when its text repeats', async () => {
    const { provider, seen } = recorder()
    setProvider('anthropic', provider)
    const llm = providerFor('anthropic')
    const a: AgentMessage = { role: 'user', content: [{ type: 'text', text: `x ${KEY}` }] }
    const b: AgentMessage = { role: 'user', content: [{ type: 'text', text: `x ${KEY}` }] }
    await llm.toolTurn!(turn([a]))
    await llm.toolTurn!(turn([b]))
    expect(JSON.stringify(seen)).not.toContain(KEY)
  })

  it('redacts history messages of structured calls once per message object', async () => {
    const seen: StructuredRequest<unknown>[] = []
    const { provider } = recorder()
    setProvider('anthropic', {
      ...provider,
      complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => {
        seen.push(req as StructuredRequest<unknown>)
        return { text: '', data: null, usage: USAGE, model: req.model, stopReason: 'end_turn' }
      }
    })
    const llm = providerFor('anthropic')
    const history = { role: 'user' as const, content: `earlier ${KEY}` }
    const req = (content: string): StructuredRequest<unknown> => ({
      model: 'claude-test',
      system: [],
      messages: [history, { role: 'user', content }],
      maxTokens: 100
    })
    calls.n = 0
    await llm.complete(req(`now ${KEY}`))
    await llm.complete(req(`again ${KEY}`))
    expect(calls.n).toBe(3)
    expect(seen[1].messages[0]).toBe(seen[0].messages[0])
    expect(JSON.stringify(seen)).not.toContain(KEY)
  })
})
