// One provider over the OpenAI chat-completions API, shared by every backend that speaks it:
// local servers (Ollama, LM Studio), Gemini's OpenAI-compatible endpoint and the generic
// "OpenAI-compatible" services (OpenRouter, Groq, Mistral, DeepSeek, Together). None of them
// guarantees structured output, so replies are asked for as JSON (schema slot when the server
// takes one), checked with zod and repaired once by sending the validation error back. Tool use
// runs through chat-completions `tools`; whether a model has it is the backend's call.
import OpenAI from 'openai'
import type { ZodType } from 'zod'
import { extractJsonObject, stripNulls } from '../json'
import { anthropicJsonSchema } from './structured'
import {
  EMPTY_USAGE,
  LlmError,
  looseToolSchema,
  type AgentMessage,
  type ChatChunk,
  type CompleteResult,
  type Effort,
  type LlmProvider,
  type ProviderId,
  type StructuredRequest,
  type ToolCall,
  type ToolContent,
  type ToolTurnRequest,
  type ToolTurnResult,
  type Usage
} from './types'

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
type ResponseFormat = ChatParams['response_format']
type Message = OpenAI.Chat.ChatCompletionMessageParam

/** How to ask for JSON; stepped down once per backend when the server rejects the richer form. */
export type JsonLevel = 'schema' | 'object' | 'none'

const jsonLevels = new Map<string, JsonLevel>()

/** Test hook: every backend starts at `schema` again. */
export function resetJsonLevels(): void {
  jsonLevels.clear()
}

function responseFormat(req: StructuredRequest<unknown>, level: JsonLevel): ResponseFormat {
  if (level === 'none' || (!req.schema && !req.json)) return undefined
  if (req.schema && level === 'schema')
    return {
      type: 'json_schema',
      json_schema: {
        name: req.schemaName ?? 'response',
        schema: anthropicJsonSchema(req.schema),
        strict: false
      }
    }
  return { type: 'json_object' }
}

const imagePart = (
  base64: string,
  mediaType?: 'image/jpeg' | 'image/png'
): OpenAI.Chat.ChatCompletionContentPartImage => ({
  type: 'image_url',
  image_url: { url: `data:${mediaType ?? 'image/jpeg'};base64,${base64}` }
})

export interface ChatParamOptions {
  /** Sent when the request has none (local servers: 0, replies vary a lot with sampling). */
  defaultTemperature?: number
  /** `reasoning_effort` for backends that map it (Gemini). */
  reasoningEffort?: (model: string, effort?: Effort) => OpenAI.ReasoningEffort | undefined
}

export function buildChatParams(
  req: StructuredRequest<unknown>,
  vision: boolean,
  level: JsonLevel = 'schema',
  opts: ChatParamOptions = { defaultTemperature: 0 }
): ChatParams {
  const messages: Message[] = []
  let system = req.system.map((b) => b.text).join('\n\n')
  // Without a schema slot the model only sees the shape in the prompt.
  if (req.schema && level !== 'schema')
    system += `\n\nReply with one JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(anthropicJsonSchema(req.schema))}`
  if (system) messages.push({ role: 'system', content: system })
  req.messages.forEach((m, i) => {
    const isLast = i === req.messages.length - 1
    if (!isLast || m.role !== 'user' || !req.images?.length || !vision) {
      messages.push({ role: m.role, content: m.content })
      return
    }
    messages.push({
      role: 'user',
      content: [
        ...req.images.map((img) => imagePart(img.base64, img.mediaType)),
        { type: 'text', text: m.content }
      ]
    })
  })
  const params: ChatParams = { model: req.model, messages, max_tokens: req.maxTokens }
  const temperature = req.temperature ?? opts.defaultTemperature
  if (temperature !== undefined) params.temperature = temperature
  const effort = opts.reasoningEffort?.(req.model, req.effort)
  if (effort) params.reasoning_effort = effort
  const format = responseFormat(req, level)
  if (format) params.response_format = format
  return params
}

// ---- tool use ----

function userParts(
  content: ToolContent[],
  vision: boolean
): OpenAI.Chat.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
  for (const c of content) {
    if (c.type === 'text') parts.push({ type: 'text', text: c.text })
    else if (c.type === 'image' && vision) parts.push(imagePart(c.base64, c.mediaType))
    else if (c.type === 'document') parts.push({ type: 'text', text: `[PDF "${c.name}" not sent]` })
  }
  return parts
}

type RawToolCall = OpenAI.Chat.ChatCompletionMessageToolCall

/** The assistant turn as the server sent it, so provider extras (Gemini thought signatures) go back unchanged. */
function rawToolCalls(raw: unknown): RawToolCall[] | null {
  const calls = (raw as { tool_calls?: unknown } | null)?.tool_calls
  return Array.isArray(calls) && calls.length ? (calls as RawToolCall[]) : null
}

function chatMessages(m: AgentMessage, vision: boolean): Message[] {
  if (m.role === 'assistant') {
    const calls =
      rawToolCalls(m.raw) ??
      m.calls.map(
        (c): RawToolCall => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) }
        })
      )
    return [
      {
        role: 'assistant',
        content: m.text || null,
        ...(m.calls.length ? { tool_calls: calls } : {})
      }
    ]
  }
  const out: Message[] = []
  const rest: ToolContent[] = []
  // Tool messages carry text only on most servers: images from tool results follow in one user message.
  const toolImages: ToolContent[] = []
  for (const c of m.content) {
    if (c.type !== 'tool_result') {
      rest.push(c)
      continue
    }
    const text = c.content.filter((x) => x.type === 'text').map((x) => x.text)
    const docs = c.content
      .filter((x) => x.type === 'document')
      .map((d) => `[PDF "${d.name}" not sent]`)
    out.push({
      role: 'tool',
      tool_call_id: c.id,
      content:
        (c.isError ? ['Error: ', ...text, ...docs] : [...text, ...docs]).join('\n') || '(no output)'
    })
    if (vision) toolImages.push(...c.content.filter((x) => x.type === 'image'))
  }
  if (toolImages.length)
    rest.unshift({ type: 'text', text: 'Images from the tool results above:' }, ...toolImages)
  const parts = userParts(rest, vision)
  if (parts.length) out.push({ role: 'user', content: parts })
  return out
}

export function buildToolChatParams(
  req: ToolTurnRequest,
  vision: boolean,
  opts: ChatParamOptions = {}
): ChatParams {
  const messages: Message[] = []
  const system = req.system.map((b) => b.text).join('\n\n')
  if (system) messages.push({ role: 'system', content: system })
  for (const m of req.messages) messages.push(...chatMessages(m, vision))
  const params: ChatParams = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens,
    // Not `strict`: most compatible servers reject or ignore it; inputs are checked by the handlers.
    tools: req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters:
          t.strict === false
            ? looseToolSchema(t, anthropicJsonSchema)
            : anthropicJsonSchema(t.schema)
      }
    })),
    tool_choice: 'auto'
  }
  if (opts.defaultTemperature !== undefined) params.temperature = opts.defaultTemperature
  const effort = opts.reasoningEffort?.(req.model, req.effort)
  if (effort) params.reasoning_effort = effort
  return params
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const v = stripNulls(JSON.parse(text || '{}') as unknown)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

type FunctionCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall

function functionCalls(message: OpenAI.Chat.ChatCompletionMessage | undefined): FunctionCall[] {
  return (message?.tool_calls ?? []).filter((c): c is FunctionCall => c.type === 'function')
}

export function toolCallsOf(message: OpenAI.Chat.ChatCompletionMessage | undefined): ToolCall[] {
  return functionCalls(message).map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.function.name,
    input: parseArgs(c.function.arguments)
  }))
}

// ---- results ----

export function toUsage(u: OpenAI.CompletionUsage | null | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE }
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: 0
  }
}

/** zod result for the reply text: data, or the first issues as text for the repair turn. */
export function validate<T>(text: string, schema: ZodType<T>): { data: T } | { error: string } {
  const raw = extractJsonObject(text)
  if (!raw) return { error: 'no JSON object found' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e) {
    return { error: `invalid JSON (${(e as Error).message})` }
  }
  const res = schema.safeParse(stripNulls(value))
  if (res.success) return { data: res.data }
  return {
    error: res.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
  }
}

function isFormatRejection(e: unknown): boolean {
  const status = (e as { status?: number }).status
  return (
    (status === 400 || status === 422) &&
    /response_format|json_schema|format/i.test(String((e as Error).message))
  )
}

/** Gemini may answer with "models/<id>"; pricing and logs use the bare id. */
const modelId = (model: string): string => model.replace(/^models\//, '')

const stopOf = (finish: string | null | undefined): string =>
  finish === 'length' ? 'max_tokens' : finish === 'tool_calls' ? 'tool_use' : 'end_turn'

// ---- provider ----

export interface ChatBackendOptions {
  id: ProviderId
  /** Client for the current settings; throws LlmError E_NO_KEY when the backend is not usable. */
  client: () => OpenAI
  /** The model accepts images. */
  vision: (model: string) => boolean
  /** The model can drive a tool-use loop (agent mode). */
  tools: (model: string) => boolean
  params?: ChatParamOptions
  /** Spoken when the backend answers 429. */
  rateLimitMessage?: string
  warmup?: () => Promise<void>
}

/** A chat-completions provider; also reports per-model tool and vision support. */
export interface ChatBackend extends LlmProvider {
  supportsTools(model: string): boolean
  supportsVision(model: string): boolean
}

export const DEFAULT_RATE_LIMIT_MESSAGE = 'The AI service is busy right now. Try again in a minute.'

/** A 429 becomes LlmError E_RATE_LIMIT with a sentence that can be spoken as is. */
export function mapRateLimit(e: unknown, message: string): unknown {
  if ((e as { status?: number })?.status === 429) return new LlmError('E_RATE_LIMIT', message)
  return e
}

export function createChatBackend(o: ChatBackendOptions): ChatBackend {
  const params = o.params ?? {}
  const rateMessage = o.rateLimitMessage ?? DEFAULT_RATE_LIMIT_MESSAGE
  const level = (): JsonLevel => jsonLevels.get(o.id) ?? 'schema'

  async function call<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn()
    } catch (e) {
      throw mapRateLimit(e, rateMessage)
    }
  }

  /** One request, stepping the JSON request form down when the server rejects it. */
  async function send(
    req: StructuredRequest<unknown>,
    signal?: AbortSignal
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const client = o.client()
    for (;;) {
      const lvl = level()
      try {
        return await call(() =>
          client.chat.completions.create(buildChatParams(req, o.vision(req.model), lvl, params), {
            signal
          })
        )
      } catch (e) {
        if (signal?.aborted || lvl === 'none' || !isFormatRejection(e)) throw e
        const next: JsonLevel = lvl === 'schema' ? 'object' : 'none'
        jsonLevels.set(o.id, next)
        console.log(`[models] ${o.id} server rejected the JSON format; using ${next}`)
      }
    }
  }

  return {
    id: o.id,
    supportsTools: o.tools,
    supportsVision: o.vision,

    async complete<T = unknown>(
      req: StructuredRequest<T>,
      signal?: AbortSignal
    ): Promise<CompleteResult<T>> {
      const res = await send(req, signal)
      let text = res.choices[0]?.message?.content ?? ''
      let usage = toUsage(res.usage)
      let stopReason = stopOf(res.choices[0]?.finish_reason)
      if (!req.schema)
        return { data: null, text, usage, model: modelId(res.model || req.model), stopReason }
      let checked = validate(text, req.schema)
      if ('error' in checked) {
        // One repair turn: the model sees its own reply and what was wrong with it.
        console.log(`[schema] ${o.id} reply invalid (${checked.error}); asking for a fix`)
        // Format fix only: the image is not sent again.
        const repair: StructuredRequest<T> = {
          ...req,
          images: [],
          messages: [
            ...req.messages,
            { role: 'assistant', content: text.slice(0, 4000) },
            {
              role: 'user',
              content: `That reply does not match the required JSON schema: ${checked.error}. Reply again with only the corrected JSON object.`
            }
          ]
        }
        const again = await send(repair, signal)
        text = again.choices[0]?.message?.content ?? ''
        usage = addUsage(usage, toUsage(again.usage))
        stopReason = stopOf(again.choices[0]?.finish_reason)
        checked = validate(text, req.schema)
      }
      return {
        data: 'data' in checked ? checked.data : null,
        text,
        usage,
        model: modelId(res.model || req.model),
        stopReason
      }
    },

    async *stream(req: StructuredRequest<unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk> {
      const client = o.client()
      const events = await call(() =>
        client.chat.completions.create(
          {
            ...buildChatParams(req, o.vision(req.model), level(), params),
            stream: true,
            stream_options: { include_usage: true }
          },
          { signal }
        )
      )
      let text = ''
      let usage: Usage = { ...EMPTY_USAGE }
      let model = req.model
      let finish: string | null = null
      for await (const ev of events) {
        if (signal?.aborted) return
        if (ev.model) model = modelId(ev.model)
        if (ev.usage) usage = toUsage(ev.usage)
        const choice = ev.choices?.[0]
        if (choice?.finish_reason) finish = choice.finish_reason
        const delta = choice?.delta?.content
        if (delta) {
          text += delta
          yield { type: 'text', text: delta }
        }
      }
      if (signal?.aborted) return
      yield { type: 'done', result: { text, usage, model, stopReason: stopOf(finish) } }
    },

    async toolTurn(req: ToolTurnRequest, signal?: AbortSignal): Promise<ToolTurnResult> {
      const client = o.client()
      const res = await call(() =>
        client.chat.completions.create(buildToolChatParams(req, o.vision(req.model), params), {
          signal
        })
      )
      const choice = res.choices[0]
      if (choice?.finish_reason === 'length' && !choice.message?.tool_calls?.length)
        throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
      const calls = toolCallsOf(choice?.message)
      // Sent back as received (minus ids the server left empty), extras included.
      const raw = functionCalls(choice?.message).map((c, i) => ({ ...c, id: calls[i].id }))
      return {
        message: {
          role: 'assistant',
          text: choice?.message?.content ?? '',
          calls,
          ...(calls.length ? { raw: { tool_calls: raw } } : {})
        },
        usage: toUsage(res.usage),
        model: modelId(res.model || req.model),
        stopReason: calls.length ? 'tool_use' : stopOf(choice?.finish_reason)
      }
    },

    warmup: o.warmup ?? (() => Promise.resolve())
  }
}
