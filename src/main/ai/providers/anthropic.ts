import Anthropic from '@anthropic-ai/sdk'
import { parseJsonAs } from '../json'
import { anthropicJsonSchema } from './structured'
import {
  EMPTY_USAGE,
  LlmError,
  REFUSAL_MESSAGE,
  retryBudget,
  type AgentMessage,
  type ChatChunk,
  type CompleteResult,
  type LlmProvider,
  type StructuredRequest,
  type ToolCall,
  type ToolContent,
  type ToolTurnRequest,
  type ToolTurnResult,
  type Usage
} from './types'

let client: Anthropic | null = null
let clientKey: string | undefined

/** Shared SDK client so requests reuse one connection pool; rebuilt if the key changes. */
export function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key })
    clientKey = key
  }
  return client
}

/** `output_config.effort` is accepted by Opus 4.5+, Sonnet 4.6+ and every 5.x model; not Haiku. */
export function supportsEffort(model: string): boolean {
  return /^claude-(opus-4-[5-9]|sonnet-4-6|(opus|sonnet|fable|mythos)-[5-9])/.test(model)
}

/** Opus 4.7+ and the 5.x family reject non-default sampling parameters. */
export function supportsTemperature(model: string): boolean {
  return !/^claude-(opus-4-[7-9]|(opus|sonnet|fable|mythos)-[5-9])/.test(model)
}

/**
 * Thinking setting for a latency-sensitive call. Sonnet 5.5 thinks adaptively unless told
 * `between_tools`; Opus 5.5 cannot turn it off; older models are off by default.
 */
export function thinkingOff(model: string): Anthropic.ThinkingConfigParam | undefined {
  return /^claude-sonnet-5-5/.test(model) ? { type: 'between_tools' } : undefined
}

type CreateParams = Anthropic.MessageCreateParamsNonStreaming

export function buildParams(req: StructuredRequest<unknown>): CreateParams {
  const system: Anthropic.TextBlockParam[] = req.system.map((b) => ({
    type: 'text',
    text: b.text,
    ...(b.cacheable ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))
  const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content
  }))
  const last = messages[messages.length - 1]
  if (last && last.role === 'user' && req.images?.length) {
    last.content = [
      ...req.images.map(
        (img): Anthropic.ImageBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType ?? 'image/jpeg', data: img.base64 }
        })
      ),
      { type: 'text', text: req.messages[req.messages.length - 1].content }
    ]
  }
  const params: CreateParams = { model: req.model, max_tokens: req.maxTokens, messages }
  if (system.length) params.system = system
  const thinking = req.thinking ? undefined : thinkingOff(req.model)
  if (thinking) params.thinking = thinking
  if (req.effort && supportsEffort(req.model)) params.output_config = { effort: req.effort }
  if (req.schema) {
    const format = { type: 'json_schema' as const, schema: anthropicJsonSchema(req.schema) }
    params.output_config = { ...params.output_config, format }
  }
  if (req.temperature !== undefined && supportsTemperature(req.model))
    params.temperature = req.temperature
  return params
}

export function toUsage(u: Partial<Anthropic.Usage> | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE }
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0
  }
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  }
}

// Tool use -----------------------------------------------------------------------------------

function contentBlock(c: ToolContent): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (c.type === 'text') return { type: 'text', text: c.text }
  return {
    type: 'image',
    source: { type: 'base64', media_type: c.mediaType ?? 'image/jpeg', data: c.base64 }
  }
}

function messageParam(m: AgentMessage): Anthropic.MessageParam {
  if (m.role === 'assistant') {
    if (Array.isArray(m.raw))
      return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] }
    const content: Anthropic.ContentBlockParam[] = []
    if (m.text) content.push({ type: 'text', text: m.text })
    for (const c of m.calls)
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
    return { role: 'assistant', content }
  }
  // tool_result blocks must come first in a user message.
  const results: Anthropic.ToolResultBlockParam[] = []
  const rest: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
  for (const c of m.content) {
    if (c.type === 'tool_result')
      results.push({
        type: 'tool_result',
        tool_use_id: c.id,
        content: c.content.map(contentBlock),
        ...(c.isError ? { is_error: true } : {})
      })
    else rest.push(contentBlock(c))
  }
  return { role: 'user', content: [...results, ...rest] }
}

/**
 * Strict tools (schema-valid inputs), auto tool choice (Sonnet/Opus 5.5 reject forced choice),
 * and three cache breakpoints: system, the last tool, and the newest user message, so each
 * turn reads the previous turn's prefix from the cache.
 */
export function buildToolParams(req: ToolTurnRequest): CreateParams {
  const base = buildParams({
    model: req.model,
    system: req.system,
    messages: [],
    maxTokens: req.maxTokens,
    effort: req.effort
  })
  const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: anthropicJsonSchema(t.schema) as Anthropic.Tool.InputSchema,
    strict: true,
    ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))
  const messages = req.messages.map(messageParam)
  const last = messages[messages.length - 1]
  if (last && Array.isArray(last.content) && last.content.length) {
    const block = last.content[last.content.length - 1] as { cache_control?: unknown }
    block.cache_control = { type: 'ephemeral' }
  }
  return { ...base, messages, tools, tool_choice: { type: 'auto' } }
}

function toolCallsOf(msg: Anthropic.Message): ToolCall[] {
  return msg.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }))
}

export function createAnthropicProvider(getClient: () => Anthropic = anthropicClient): LlmProvider {
  const send = (params: CreateParams, signal?: AbortSignal): Promise<Anthropic.Message> =>
    getClient().messages.create(params, { signal })

  return {
    id: 'anthropic',

    async complete<T = unknown>(
      req: StructuredRequest<T>,
      signal?: AbortSignal
    ): Promise<CompleteResult<T>> {
      const params = buildParams(req)
      let msg = await send(params, signal)
      let usage = toUsage(msg.usage)
      if (msg.stop_reason === 'max_tokens') {
        const budget = retryBudget(params.max_tokens)
        if (budget === null) throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
        console.log(`[fail] truncated response, retrying with max_tokens ${budget}`)
        msg = await send({ ...params, max_tokens: budget }, signal)
        usage = addUsage(usage, toUsage(msg.usage))
        if (msg.stop_reason === 'max_tokens')
          throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
      }
      if (msg.stop_reason === 'refusal') throw new LlmError('E_REFUSED', REFUSAL_MESSAGE)
      const text = textOf(msg)
      const data = req.schema ? parseJsonAs(text, req.schema) : null
      return { data, text, usage, model: msg.model, stopReason: msg.stop_reason ?? '' }
    },

    async *stream(req: StructuredRequest<unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk> {
      const events = await getClient().messages.create(
        { ...buildParams(req), stream: true },
        { signal }
      )
      let text = ''
      let model = req.model
      let stopReason = ''
      let usage: Usage = { ...EMPTY_USAGE }
      for await (const ev of events) {
        if (signal?.aborted) return
        if (ev.type === 'message_start') {
          model = ev.message.model
          usage = toUsage(ev.message.usage)
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text
          yield { type: 'text', text: ev.delta.text }
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta.stop_reason ?? stopReason
          usage.outputTokens = ev.usage.output_tokens ?? usage.outputTokens
        }
      }
      if (signal?.aborted) return
      if (stopReason === 'refusal') throw new LlmError('E_REFUSED', REFUSAL_MESSAGE)
      yield { type: 'done', result: { text, usage, model, stopReason } }
    },

    async toolTurn(req: ToolTurnRequest, signal?: AbortSignal): Promise<ToolTurnResult> {
      const params = buildToolParams(req)
      let msg = await send(params, signal)
      let usage = toUsage(msg.usage)
      if (msg.stop_reason === 'max_tokens') {
        const budget = retryBudget(params.max_tokens)
        if (budget === null) throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
        msg = await send({ ...params, max_tokens: budget }, signal)
        usage = addUsage(usage, toUsage(msg.usage))
        if (msg.stop_reason === 'max_tokens')
          throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
      }
      if (msg.stop_reason === 'refusal') throw new LlmError('E_REFUSED', REFUSAL_MESSAGE)
      return {
        message: {
          role: 'assistant',
          text: textOf(msg),
          calls: toolCallsOf(msg),
          raw: msg.content
        },
        usage,
        model: msg.model,
        stopReason: msg.stop_reason ?? ''
      }
    },

    async warmup(): Promise<void> {
      try {
        await getClient().models.list({ limit: 1 })
      } catch (e) {
        console.warn('[warmup] anthropic:', (e as Error).message)
      }
    }
  }
}
