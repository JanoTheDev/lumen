import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { ZodType } from 'zod'
import {
  EMPTY_USAGE,
  LlmError,
  REFUSAL_MESSAGE,
  retryBudget,
  type ChatChunk,
  type ChatRequest,
  type CompleteResult,
  type Effort,
  type LlmProvider,
  type StructuredRequest,
  type Usage
} from './types'

let client: OpenAI | null = null
let clientKey: string | undefined

/** Shared SDK client so requests reuse one connection pool; rebuilt if the key changes. */
export function openaiClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key })
    clientKey = key
  }
  return client
}

/** gpt-5*, gpt-6* and o-series models take `reasoning.effort`; other chat models reject it. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/i.test(model)
}

/** The original gpt-5 family accepts `minimal`; later ones use `none`/`low` instead. */
function acceptsMinimal(model: string): boolean {
  return /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/i.test(model)
}

/** Reasoning effort to send, or undefined for models that reject the parameter. */
export function reasoningEffort(
  model: string,
  effort: Effort = 'low'
): OpenAI.ReasoningEffort | undefined {
  if (!isReasoningModel(model)) return undefined
  if (effort === 'low' && acceptsMinimal(model)) return 'minimal'
  return effort
}

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming

export function buildParams(req: ChatRequest): CreateParams {
  const input: OpenAI.Responses.ResponseInput = req.messages.map((m, i) => {
    const isLast = i === req.messages.length - 1
    if (!isLast || m.role !== 'user' || !req.images?.length) {
      return { role: m.role, content: m.content }
    }
    return {
      role: 'user',
      content: [
        ...req.images.map(
          (img): OpenAI.Responses.ResponseInputImage => ({
            type: 'input_image',
            image_url: `data:${img.mediaType ?? 'image/jpeg'};base64,${img.base64}`,
            detail: img.detail ?? 'high'
          })
        ),
        { type: 'input_text', text: m.content }
      ]
    }
  })
  const params: CreateParams = {
    model: req.model,
    input,
    max_output_tokens: req.maxTokens,
    store: false
  }
  if (req.system.length) params.instructions = req.system.map((b) => b.text).join('\n\n')
  const effort = reasoningEffort(req.model, req.effort)
  if (effort) params.reasoning = { effort }
  else if (req.temperature !== undefined) params.temperature = req.temperature
  if (req.json) params.text = { format: { type: 'json_object' } }
  return params
}

export function toUsage(u: OpenAI.Responses.ResponseUsage | null | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE }
  const cached = u.input_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, u.input_tokens - cached),
    outputTokens: u.output_tokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0
  }
}

function textOf(res: OpenAI.Responses.Response): string {
  let text = ''
  for (const item of res.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content) if (c.type === 'output_text') text += c.text
  }
  return text
}

function refused(res: OpenAI.Responses.Response): boolean {
  return (res.output ?? []).some(
    (item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal')
  )
}

function truncated(res: OpenAI.Responses.Response): boolean {
  return res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens'
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  }
}

export function createOpenAIProvider(getClient: () => OpenAI = openaiClient): LlmProvider {
  async function send<T>(
    params: CreateParams,
    schema: ZodType<T> | undefined,
    schemaName: string,
    signal?: AbortSignal
  ): Promise<{ res: OpenAI.Responses.Response; data: T | null }> {
    if (!schema) return { res: await getClient().responses.create(params, { signal }), data: null }
    const res = await getClient().responses.parse(
      { ...params, text: { format: zodTextFormat(schema, schemaName) } },
      { signal }
    )
    return { res, data: (res.output_parsed as T | null) ?? null }
  }

  return {
    id: 'openai',

    async complete<T = unknown>(
      req: StructuredRequest<T>,
      signal?: AbortSignal
    ): Promise<CompleteResult<T>> {
      const params = buildParams(req)
      const name = req.schemaName ?? 'response'
      let { res, data } = await send(params, req.schema, name, signal)
      let usage = toUsage(res.usage)
      if (truncated(res)) {
        const budget = retryBudget(req.maxTokens)
        if (budget === null) throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
        console.log(`[fail] truncated response, retrying with max_output_tokens ${budget}`)
        ;({ res, data } = await send(
          { ...params, max_output_tokens: budget },
          req.schema,
          name,
          signal
        ))
        usage = addUsage(usage, toUsage(res.usage))
        if (truncated(res)) throw new LlmError('E_TRUNCATED', 'The reply was cut off.')
      }
      if (refused(res)) throw new LlmError('E_REFUSED', REFUSAL_MESSAGE)
      const stopReason = res.status === 'incomplete' ? 'incomplete' : 'end_turn'
      return { data, text: textOf(res), usage, model: res.model, stopReason }
    },

    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
      const events = await getClient().responses.create(
        { ...buildParams(req), stream: true },
        { signal }
      )
      let text = ''
      let final: OpenAI.Responses.Response | null = null
      let refusal = false
      for await (const ev of events) {
        if (signal?.aborted) return
        if (ev.type === 'response.output_text.delta') {
          text += ev.delta
          yield { type: 'text', text: ev.delta }
        } else if (ev.type === 'response.refusal.delta') {
          refusal = true
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          final = ev.response
        } else if (ev.type === 'response.failed') {
          throw new Error(ev.response.error?.message ?? 'The model request failed.')
        }
      }
      if (signal?.aborted) return
      if (refusal) throw new LlmError('E_REFUSED', REFUSAL_MESSAGE)
      yield {
        type: 'done',
        result: {
          text,
          usage: toUsage(final?.usage),
          model: final?.model ?? req.model,
          stopReason: final && truncated(final) ? 'max_tokens' : 'end_turn'
        }
      }
    },

    async warmup(): Promise<void> {
      try {
        await getClient().models.list()
      } catch (e) {
        console.warn('[warmup] openai:', (e as Error).message)
      }
    }
  }
}
