// Local models through an OpenAI-compatible server (Ollama or LM Studio), found without any
// config: Ollama on :11434 (/api/tags), then LM Studio on :1234 (/v1/models). A configured
// models.localUrl / models.localModel wins. Experimental: there is no structured-output
// guarantee, so replies are asked for as JSON (schema hint when the server takes one), checked
// with zod, and repaired once by sending the validation error back.
import OpenAI from 'openai'
import type { ZodType } from 'zod'
import { extractJsonObject, stripNulls } from '../json'
import { anthropicJsonSchema } from './structured'
import {
  EMPTY_USAGE,
  LlmError,
  type ChatChunk,
  type CompleteResult,
  type LlmProvider,
  type StructuredRequest,
  type Usage
} from './types'

export type LocalKind = 'ollama' | 'lmstudio' | 'custom'

export interface LocalServer {
  kind: LocalKind
  /** Server root without /v1, e.g. http://localhost:11434 */
  baseUrl: string
  /** Installed models (chat-capable ones first). */
  models: string[]
  /** Model every role uses. */
  model: string
  /** The picked model accepts images. */
  vision: boolean
}

export const OLLAMA_URL = 'http://localhost:11434'
export const LMSTUDIO_URL = 'http://localhost:1234'

const PROBE_TIMEOUT_MS = 800
const SHOW_TIMEOUT_MS = 1500

// Vision families by name, best first (checked against ollama.com/search?c=vision,
// 2026-10-01). Used to rank, and as the vision test when the server gives no capabilities.
const VISION_PREFERENCE = [
  /^qwen3\.[5-9]/i,
  /^gemma4/i,
  /^qwen2\.5-?vl/i,
  /^gemma3(?!n)/i,
  /^mistral-small3\.[12]/i,
  /^llama3\.2-vision/i,
  /^llama4/i,
  /^minicpm-v/i,
  /^granite3\.2-vision/i,
  /^llava/i,
  /^moondream/i
]
const VISION_NAME_RE = /(vision|-vl\b|vl:|^llava|^bakllava|^minicpm-v|^moondream)/i
const NOT_CHAT_RE = /(embed|bge-|nomic-|rerank|whisper|ocr)/i

export function looksVision(model: string): boolean {
  const name = model.split('/').pop() ?? model
  return VISION_NAME_RE.test(name) || VISION_PREFERENCE.some((re) => re.test(name))
}

function visionRank(model: string): number {
  const name = model.split('/').pop() ?? model
  const i = VISION_PREFERENCE.findIndex((re) => re.test(name))
  return i < 0 ? VISION_PREFERENCE.length : i
}

/**
 * The model to use: the configured one when installed, else the best vision model, else the
 * first chat model. `vision` maps model → capability when the server reported it.
 */
export function pickModel(
  models: string[],
  vision: Map<string, boolean>,
  preferred?: string
): { model: string; vision: boolean } | null {
  const chat = models.filter((m) => !NOT_CHAT_RE.test(m))
  if (!chat.length) return null
  const isVision = (m: string): boolean => vision.get(m) ?? looksVision(m)
  if (preferred) {
    const hit = chat.find((m) => m === preferred || m.startsWith(`${preferred}:`))
    if (hit) return { model: hit, vision: isVision(hit) }
  }
  const withVision = chat.filter(isVision).sort((a, b) => visionRank(a) - visionRank(b))
  if (withVision.length) return { model: withVision[0], vision: true }
  return { model: chat[0], vision: false }
}

type Fetch = typeof fetch

interface Probe {
  models: string[]
  vision: Map<string, boolean>
  pick: { model: string; vision: boolean } | null
}

async function getJson(
  fetchFn: Fetch,
  url: string,
  timeoutMs: number,
  body?: unknown
): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function probeOllama(fetchFn: Fetch, baseUrl: string, preferred?: string): Promise<Probe> {
  const tags = await getJson(fetchFn, `${baseUrl}/api/tags`, PROBE_TIMEOUT_MS)
  const models = ((tags.models as { name?: string; model?: string }[]) ?? [])
    .map((m) => m.name ?? m.model ?? '')
    .filter(Boolean)
  // /api/show lists capabilities ("vision") on current Ollama; names are the fallback.
  const vision = new Map<string, boolean>()
  await Promise.all(
    models
      .filter((m) => !NOT_CHAT_RE.test(m))
      .slice(0, 12)
      .map(async (m) => {
        try {
          const show = await getJson(fetchFn, `${baseUrl}/api/show`, SHOW_TIMEOUT_MS, { model: m })
          if (Array.isArray(show.capabilities))
            vision.set(m, (show.capabilities as string[]).includes('vision'))
        } catch {
          /* older server: name heuristic */
        }
      })
  )
  return { models, vision, pick: pickModel(models, vision, preferred) }
}

async function probeOpenAiCompatible(
  fetchFn: Fetch,
  baseUrl: string,
  preferred?: string
): Promise<Probe> {
  const list = await getJson(fetchFn, `${baseUrl}/v1/models`, PROBE_TIMEOUT_MS)
  const models = ((list.data as { id?: string }[]) ?? []).map((m) => m.id ?? '').filter(Boolean)
  // LM Studio's own API says which models are vision-language ("vlm").
  const vision = new Map<string, boolean>()
  try {
    const v0 = await getJson(fetchFn, `${baseUrl}/api/v0/models`, PROBE_TIMEOUT_MS)
    for (const m of (v0.data as { id?: string; type?: string }[]) ?? [])
      if (m.id) vision.set(m.id, m.type === 'vlm')
  } catch {
    /* not LM Studio: name heuristic */
  }
  return { models, vision, pick: pickModel(models, vision, preferred) }
}

export interface DetectOptions {
  /** models.localUrl: probe only this server. */
  url?: string
  /** models.localModel */
  model?: string
  fetch?: Fetch
}

/** Finds a running local server with at least one chat model, or null. Never throws. */
export async function detectLocal(opts: DetectOptions = {}): Promise<LocalServer | null> {
  const fetchFn = opts.fetch ?? fetch
  const configured = opts.url?.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  const candidates: { kind: LocalKind; baseUrl: string }[] = configured
    ? [{ kind: 'custom', baseUrl: configured }]
    : [
        { kind: 'ollama', baseUrl: OLLAMA_URL },
        { kind: 'lmstudio', baseUrl: LMSTUDIO_URL }
      ]
  for (const c of candidates) {
    // A custom URL may be either kind: try Ollama's API first, then plain OpenAI-compatible.
    const probes =
      c.kind === 'ollama'
        ? [probeOllama]
        : c.kind === 'lmstudio'
          ? [probeOpenAiCompatible]
          : [probeOllama, probeOpenAiCompatible]
    for (const probe of probes) {
      try {
        const found = await probe(fetchFn, c.baseUrl, opts.model)
        if (found.pick)
          return { kind: c.kind, baseUrl: c.baseUrl, models: found.models, ...found.pick }
      } catch {
        /* not running */
      }
    }
  }
  return null
}

// ---- detection state (models.ts reads it synchronously) ----

let server: LocalServer | null = null
let checkedAt = 0
let checkedFor = ''
let inflight: Promise<LocalServer | null> | null = null
const FOUND_TTL_MS = 60_000
const MISSING_TTL_MS = 15_000

/** The last detected server, or null. */
export function localServer(): LocalServer | null {
  return server
}

/** Re-detects when the last result is stale (or always with force). Never throws. */
export function refreshLocal(
  opts: DetectOptions & { force?: boolean } = {}
): Promise<LocalServer | null> {
  const ttl = server ? FOUND_TTL_MS : MISSING_TTL_MS
  const key = `${opts.url ?? ''}|${opts.model ?? ''}`
  const fresh = Date.now() - checkedAt < ttl && key === checkedFor
  if (!opts.force && fresh) return Promise.resolve(server)
  inflight ??= detectLocal(opts)
    .then((found) => {
      const changed = found?.baseUrl !== server?.baseUrl || found?.model !== server?.model
      if (changed)
        console.log(
          found
            ? `[models] local ${found.kind} at ${found.baseUrl}: ${found.model}${found.vision ? ' (vision)' : ' (text only)'}, ${found.models.length} installed`
            : '[models] no local model server running'
        )
      server = found
      checkedAt = Date.now()
      checkedFor = key
      return found
    })
    .finally(() => (inflight = null))
  return inflight
}

/** Test hook. */
export function setLocalServer(s: LocalServer | null): void {
  server = s
  checkedAt = s ? Date.now() : 0
}

// ---- provider ----

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
type ResponseFormat = ChatParams['response_format']

/** How to ask for JSON; downgraded once per server when it rejects the richer form. */
type JsonLevel = 'schema' | 'object' | 'none'
let jsonLevel: JsonLevel = 'schema'

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

export function buildChatParams(
  req: StructuredRequest<unknown>,
  vision: boolean,
  level: JsonLevel = jsonLevel
): ChatParams {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
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
        ...req.images.map(
          (img): OpenAI.Chat.ChatCompletionContentPartImage => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType ?? 'image/jpeg'};base64,${img.base64}` }
          })
        ),
        { type: 'text', text: m.content }
      ]
    })
  })
  const params: ChatParams = { model: req.model, messages, max_tokens: req.maxTokens }
  // Deterministic by default: local replies vary a lot with sampling.
  params.temperature = req.temperature ?? 0
  const format = responseFormat(req, level)
  if (format) params.response_format = format
  return params
}

function toUsage(u: OpenAI.CompletionUsage | null | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE }
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: 0,
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

let client: { url: string; sdk: OpenAI } | null = null

function sdkFor(baseUrl: string): OpenAI {
  const url = `${baseUrl}/v1`
  if (client?.url !== url)
    client = { url, sdk: new OpenAI({ apiKey: 'local', baseURL: url, maxRetries: 0 }) }
  return client.sdk
}

export function createLocalProvider(
  getServer: () => LocalServer | null = localServer,
  getClient: (baseUrl: string) => OpenAI = sdkFor
): LlmProvider {
  const current = (): LocalServer => {
    const s = getServer()
    if (!s) throw new LlmError('E_NO_KEY', 'No local model server is running.')
    return s
  }

  /** One request, stepping the JSON request form down when the server rejects it. */
  async function send(
    req: StructuredRequest<unknown>,
    signal?: AbortSignal
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const s = current()
    for (;;) {
      try {
        return await getClient(s.baseUrl).chat.completions.create(
          buildChatParams(req, s.vision, jsonLevel),
          { signal }
        )
      } catch (e) {
        if (signal?.aborted || jsonLevel === 'none' || !isFormatRejection(e)) throw e
        jsonLevel = jsonLevel === 'schema' ? 'object' : 'none'
        console.log(`[models] local server rejected the JSON format; using ${jsonLevel}`)
      }
    }
  }

  return {
    id: 'local',

    async complete<T = unknown>(
      req: StructuredRequest<T>,
      signal?: AbortSignal
    ): Promise<CompleteResult<T>> {
      const res = await send(req, signal)
      let text = res.choices[0]?.message?.content ?? ''
      let usage = toUsage(res.usage)
      let stopReason = res.choices[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      if (!req.schema) return { data: null, text, usage, model: res.model || req.model, stopReason }
      let checked = validate(text, req.schema)
      if ('error' in checked) {
        // One repair turn: the model sees its own reply and what was wrong with it.
        console.log(`[schema] local reply invalid (${checked.error}); asking for a fix`)
        // Format fix only: the image is not sent again (slow on local hardware).
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
        stopReason = again.choices[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
        checked = validate(text, req.schema)
      }
      return {
        data: 'data' in checked ? checked.data : null,
        text,
        usage,
        model: res.model || req.model,
        stopReason
      }
    },

    async *stream(req: StructuredRequest<unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk> {
      const s = current()
      const events = await getClient(s.baseUrl).chat.completions.create(
        {
          ...buildChatParams(req, s.vision, jsonLevel),
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal }
      )
      let text = ''
      let usage: Usage = { ...EMPTY_USAGE }
      let model = req.model
      let finish: string | null = null
      for await (const ev of events) {
        if (signal?.aborted) return
        if (ev.model) model = ev.model
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
      yield {
        type: 'done',
        result: { text, usage, model, stopReason: finish === 'length' ? 'max_tokens' : 'end_turn' }
      }
    },

    // Detection (providers/index refreshLocalModels) already opened the connection.
    warmup: () => Promise.resolve()
  }
}

/** Test hook. */
export function resetLocalJsonLevel(): void {
  jsonLevel = 'schema'
}
