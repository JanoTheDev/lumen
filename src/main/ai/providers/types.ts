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

export interface LlmProvider {
  id: ProviderId
  /** With a schema the reply is constrained JSON; the caller parses the final text. */
  stream(req: StructuredRequest<unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk>
  complete<T = unknown>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<CompleteResult<T>>
  /** Opens the connection pool early; never throws. */
  warmup(): Promise<void>
  /** One tool-use turn; absent for providers without tool calling (local servers). */
  toolTurn?: ToolCapable['toolTurn']
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

// ---- Tool use (agent mode) ----

/**
 * One tool the model may call. The zod schema becomes each provider's strict JSON schema.
 * `strict: false` sends a best-effort tool instead: any JSON Schema (`jsonSchema` when given,
 * else the zod one), outside the strict limits (Anthropic: 20 strict tools, 24 optional and 16
 * union parameters across all strict schemas of a request), but inputs are not guaranteed to
 * match, so the handler must check them.
 */
export interface ToolDef {
  name: string
  description: string
  schema: ZodType
  /** Default true. */
  strict?: boolean
  /** Non-strict only: the input JSON Schema as is (an object schema), e.g. an MCP tool's. */
  jsonSchema?: Record<string, unknown>
}

/** The schema of a non-strict tool: the raw one when given, else the zod one, as an object. */
export function looseToolSchema(
  t: ToolDef,
  fromZod: (s: ZodType) => Record<string, unknown>
): Record<string, unknown> {
  const s = t.jsonSchema ?? fromZod(t.schema)
  return { ...s, type: 'object', properties: s.properties ?? {} }
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType?: 'image/jpeg' | 'image/png' }

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  id: string
  content: ToolContent[]
  isError?: boolean
}

export type AgentMessage =
  | { role: 'user'; content: (ToolContent | ToolResultBlock)[] }
  | {
      role: 'assistant'
      text: string
      calls: ToolCall[]
      /** Provider-native content (thinking blocks) to send back unchanged. */
      raw?: unknown
    }

export interface ToolTurnRequest {
  model: string
  system: SystemBlock[]
  tools: ToolDef[]
  /** Oldest first; starts and ends with a user message. */
  messages: AgentMessage[]
  maxTokens: number
  effort?: Effort
}

export interface ToolTurnResult {
  /** The assistant message to append to the conversation. */
  message: Extract<AgentMessage, { role: 'assistant' }>
  usage: Usage
  model: string
  stopReason: string
}

/** Providers that can run a tool-use loop (agent mode). */
export interface ToolCapable {
  toolTurn(req: ToolTurnRequest, signal?: AbortSignal): Promise<ToolTurnResult>
}
