import type { ZodType } from 'zod'

export type ProviderId = 'anthropic' | 'openai' | 'local'

/** A system prompt section. Cacheable blocks must be byte-identical across calls. */
export interface SystemBlock {
  text: string
  cacheable: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A screenshot or crop sent with the last user message. */
export interface Frame {
  base64: string
  mediaType?: 'image/jpeg' | 'image/png'
  /** OpenAI only: vision detail level. */
  detail?: 'low' | 'high' | 'auto'
}

export type Effort = 'low' | 'medium' | 'high'

export interface ChatRequest {
  model: string
  system: SystemBlock[]
  /** Oldest first; the last entry must be the user turn. Images attach to it. */
  messages: ChatMessage[]
  images?: Frame[]
  maxTokens: number
  /** Dropped for models that do not accept it. */
  effort?: Effort
  /** Dropped for models that reject sampling parameters. */
  temperature?: number
  /** Let the model think before answering (default off where the model allows it). */
  thinking?: boolean
  /** Ask for a bare JSON object (no schema). Ignored when a schema is given. */
  json?: boolean
}

export interface StructuredRequest<T> extends ChatRequest {
  schema?: ZodType<T>
  schemaName?: string
}

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ChatResult {
  text: string
  usage: Usage
  model: string
  stopReason: string
}

export interface CompleteResult<T> extends ChatResult {
  /** Parsed output when a schema was given and the output matched it. */
  data: T | null
}

export type ChatChunk = { type: 'text'; text: string } | { type: 'done'; result: ChatResult }

export interface ModelInfo {
  id: string
  provider: ProviderId
}

export interface LlmProvider {
  id: ProviderId
  /** With a schema the reply is constrained JSON; the caller parses the final text. */
  stream(req: StructuredRequest<unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk>
  complete<T = unknown>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<CompleteResult<T>>
  /** Opens the connection pool early; never throws. */
  warmup(): Promise<void>
}

export type LlmErrorCode = 'E_TRUNCATED' | 'E_REFUSED' | 'E_NO_KEY'

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export const REFUSAL_MESSAGE = "Sorry, I can't help with that one."

export const MAX_RETRY_TOKENS = 8192

/** Token budget for the single retry after a truncated reply, or null when none is left. */
export function retryBudget(maxTokens: number): number | null {
  const next = Math.min(maxTokens * 2, MAX_RETRY_TOKENS)
  return next > maxTokens ? next : null
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}
