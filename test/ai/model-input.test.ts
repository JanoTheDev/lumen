import { afterEach, describe, expect, it } from 'vitest'
import { PLAIN_STYLE_LINE } from '../../src/main/a11y/phrases'
import { SYSTEM_PREFIX, userTurn } from '../../src/main/ai/prompts/assemble'
import { replyLanguageLine } from '../../src/main/speech/language'
import { providerFor, setDeterministic, setProvider } from '../../src/main/ai/providers'
import type {
  ChatChunk,
  CompleteResult,
  LlmProvider,
  StructuredRequest,
  ToolTurnRequest,
  ToolTurnResult
} from '../../src/main/ai/providers/types'

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }

function recorder(): { provider: LlmProvider; seen: unknown[] } {
  const seen: unknown[] = []
  const provider: LlmProvider = {
    id: 'anthropic',
    async *stream(req): AsyncIterable<ChatChunk> {
      seen.push(req)
      yield {
        type: 'done',
        result: { text: '', usage: USAGE, model: req.model, stopReason: 'end_turn' }
      }
    },
    complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => {
      seen.push(req)
      return { text: '', data: null, usage: USAGE, model: req.model, stopReason: 'end_turn' }
    },
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

const KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456'
const CARD = '4242 4242 4242 4242'

describe('model input redaction', () => {
  afterEach(() => {
    setProvider('anthropic', null)
    setDeterministic(false)
  })

  it('redacts secrets in messages but keeps the system prompt byte-identical', async () => {
    const { provider, seen } = recorder()
    setProvider('anthropic', provider)
    const system = [{ text: `Lumen system ${KEY}`, cacheable: true }]
    await providerFor('anthropic').complete({
      model: 'm',
      system,
      maxTokens: 10,
      messages: [
        { role: 'user', content: `my key is ${KEY}` },
        { role: 'assistant', content: `card ${CARD}` },
        { role: 'user', content: 'elements: e1 edit "Password" value="password: hunter22"' }
      ]
    })
    const req = seen[0] as StructuredRequest<unknown>
    expect(req.system).toEqual(system)
    expect(req.messages[0].content).toBe('my key is [redacted:api-key]')
    expect(req.messages[1].content).toBe('card [redacted:card]')
    expect(req.messages[2].content).not.toContain('hunter22')
    expect(req.temperature).toBeUndefined()
  })

  it('redacts streamed requests and tool results, never images', async () => {
    const { provider, seen } = recorder()
    setProvider('anthropic', provider)
    const llm = providerFor('anthropic')
    for await (const chunk of llm.stream({
      model: 'm',
      system: [],
      maxTokens: 10,
      messages: [{ role: 'user', content: `paste ${KEY}` }]
    }))
      void chunk
    expect((seen[0] as StructuredRequest<unknown>).messages[0].content).toBe(
      'paste [redacted:api-key]'
    )
    await llm.toolTurn!({
      model: 'm',
      system: [],
      tools: [],
      maxTokens: 10,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `goal ${CARD}` }] },
        { role: 'assistant', text: 'reading', calls: [{ id: 't1', name: 'read', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              id: 't1',
              content: [
                { type: 'text', text: `page text ${KEY}` },
                { type: 'image', base64: 'IMG' }
              ]
            }
          ]
        }
      ]
    })
    const tool = seen[1] as ToolTurnRequest
    expect(JSON.stringify(tool.messages)).not.toContain(KEY)
    expect(JSON.stringify(tool.messages)).not.toContain('4242 4242')
    expect(JSON.stringify(tool.messages)).toContain('"base64":"IMG"')
  })

  it('sends temperature 0 in deterministic mode', async () => {
    const { provider, seen } = recorder()
    setProvider('anthropic', provider)
    setDeterministic(true)
    await providerFor('anthropic').complete({
      model: 'm',
      system: [],
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect((seen[0] as StructuredRequest<unknown>).temperature).toBe(0)
  })
})

describe('per-user lines in the user turn', () => {
  const base = { prompt: 'how do I attach a file', activeWindow: 'Gmail', frame: null }

  it('adds the plain style line to the user turn only in simple mode', () => {
    expect(userTurn(base)).not.toContain(PLAIN_STYLE_LINE)
    expect(userTurn({ ...base, style: 'plain' })).toContain(PLAIN_STYLE_LINE)
  })

  it('puts the reply language in the user turn, not the cached prefix', () => {
    const line = replyLanguageLine('es')
    expect(line).toContain('Spanish')
    expect(replyLanguageLine('en')).toBe('')
    expect(userTurn({ ...base, language: line })).toContain(line)
    expect(SYSTEM_PREFIX).not.toContain('Spanish')
  })
})
