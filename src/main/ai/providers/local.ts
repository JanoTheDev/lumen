// Local models through an OpenAI-compatible server (Ollama or LM Studio), found without any
// config: Ollama on :11434 (/api/tags), then LM Studio on :1234 (/v1/models). A configured
// models.localUrl / models.localModel wins. Each installed model's vision and tool support comes
// from the server (Ollama /api/show capabilities, LM Studio /api/v1/models capabilities), else
// from the name (and no tools). Requests go through the shared chat-completions backend: JSON
// (schema slot when the server takes one), zod check, one repair turn.
import OpenAI from 'openai'
import { createChatBackend, resetJsonLevels, type ChatBackend } from './chat-completions'
import { LlmError } from './types'

export { buildChatParams, validate } from './chat-completions'

export type LocalKind = 'ollama' | 'lmstudio' | 'custom'

export interface ModelCaps {
  vision: boolean
  tools: boolean
}

export interface LocalServer {
  kind: LocalKind
  /** Server root without /v1, e.g. http://localhost:11434 */
  baseUrl: string
  /** Installed models (chat-capable ones first). */
  models: string[]
  /** Model every role uses unless a role picks another. */
  model: string
  /** The picked model accepts images. */
  vision: boolean
  /** The picked model can call tools (agent mode). Unknown counts as no. */
  tools?: boolean
  /** Per installed chat model, as far as the server said (else the name heuristic, no tools). */
  info?: Record<string, ModelCaps>
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

/** Installed models that can chat (no embedding / rerank / speech models). */
export function chatModels(models: string[]): string[] {
  return models.filter((m) => !NOT_CHAT_RE.test(m))
}

/**
 * The model to use: the configured one when installed, else the best vision model (one with
 * tool use first), else a chat model with tool use, else the first chat model. `vision` and
 * `tools` map model → capability when the server reported it.
 */
export function pickModel(
  models: string[],
  vision: Map<string, boolean>,
  preferred?: string,
  tools: Map<string, boolean> = new Map()
): { model: string; vision: boolean } | null {
  const chat = chatModels(models)
  if (!chat.length) return null
  const isVision = (m: string): boolean => vision.get(m) ?? looksVision(m)
  if (preferred) {
    const hit = chat.find((m) => m === preferred || m.startsWith(`${preferred}:`))
    if (hit) return { model: hit, vision: isVision(hit) }
  }
  const toolRank = (m: string): number => (tools.get(m) ? 0 : 1)
  const withVision = chat
    .filter(isVision)
    .sort((a, b) => toolRank(a) - toolRank(b) || visionRank(a) - visionRank(b))
  if (withVision.length) return { model: withVision[0], vision: true }
  return { model: chat.find((m) => tools.get(m)) ?? chat[0], vision: false }
}

/** What a model can do: the server's answer when it gave one, else the name (no tools). */
export function capsOf(server: LocalServer, model: string): ModelCaps {
  if (model === server.model) return { vision: server.vision, tools: server.tools ?? false }
  return server.info?.[model] ?? { vision: looksVision(model), tools: false }
}

type Fetch = typeof fetch

interface Probe {
  models: string[]
  vision: Map<string, boolean>
  tools: Map<string, boolean>
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

async function probeOllama(fetchFn: Fetch, baseUrl: string): Promise<Probe> {
  const tags = await getJson(fetchFn, `${baseUrl}/api/tags`, PROBE_TIMEOUT_MS)
  const models = ((tags.models as { name?: string; model?: string }[]) ?? [])
    .map((m) => m.name ?? m.model ?? '')
    .filter(Boolean)
  // /api/show lists capabilities ("vision", "tools") on current Ollama; names are the fallback.
  const vision = new Map<string, boolean>()
  const tools = new Map<string, boolean>()
  await Promise.all(
    chatModels(models)
      .slice(0, 12)
      .map(async (m) => {
        try {
          const show = await getJson(fetchFn, `${baseUrl}/api/show`, SHOW_TIMEOUT_MS, { model: m })
          if (Array.isArray(show.capabilities)) {
            const caps = show.capabilities as string[]
            vision.set(m, caps.includes('vision'))
            tools.set(m, caps.includes('tools'))
          }
        } catch {
          /* older server: name heuristic */
        }
      })
  )
  return { models, vision, tools }
}

interface LmStudioModel {
  key?: string
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean }
}

async function probeOpenAiCompatible(fetchFn: Fetch, baseUrl: string): Promise<Probe> {
  const list = await getJson(fetchFn, `${baseUrl}/v1/models`, PROBE_TIMEOUT_MS)
  const models = ((list.data as { id?: string }[]) ?? []).map((m) => m.id ?? '').filter(Boolean)
  // LM Studio's own API: /api/v1/models has capabilities {vision, trained_for_tool_use}; the
  // older /api/v0/models only says which models are vision-language ("vlm").
  const vision = new Map<string, boolean>()
  const tools = new Map<string, boolean>()
  try {
    const v1 = await getJson(fetchFn, `${baseUrl}/api/v1/models`, PROBE_TIMEOUT_MS)
    for (const m of (v1.models as LmStudioModel[]) ?? []) {
      if (!m.key || !m.capabilities) continue
      vision.set(m.key, !!m.capabilities.vision)
      tools.set(m.key, !!m.capabilities.trained_for_tool_use)
    }
  } catch {
    try {
      const v0 = await getJson(fetchFn, `${baseUrl}/api/v0/models`, PROBE_TIMEOUT_MS)
      for (const m of (v0.data as { id?: string; type?: string }[]) ?? [])
        if (m.id) vision.set(m.id, m.type === 'vlm')
    } catch {
      /* not LM Studio: name heuristic */
    }
  }
  return { models, vision, tools }
}

export interface DetectOptions {
  /** models.localUrl: probe only this server. */
  url?: string
  /** models.localModel */
  model?: string
  fetch?: Fetch
}

function serverFrom(
  kind: LocalKind,
  baseUrl: string,
  p: Probe,
  preferred?: string
): LocalServer | null {
  const pick = pickModel(p.models, p.vision, preferred, p.tools)
  if (!pick) return null
  const info: Record<string, ModelCaps> = {}
  for (const m of chatModels(p.models))
    info[m] = { vision: p.vision.get(m) ?? looksVision(m), tools: p.tools.get(m) ?? false }
  return { kind, baseUrl, models: p.models, ...pick, tools: info[pick.model].tools, info }
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
        const found = serverFrom(c.kind, c.baseUrl, await probe(fetchFn, c.baseUrl), opts.model)
        if (found) return found
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
            ? `[models] local ${found.kind} at ${found.baseUrl}: ${found.model}${found.vision ? ' (vision)' : ' (text only)'}${found.tools ? ' (tools)' : ''}, ${found.models.length} installed`
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
): ChatBackend {
  const current = (): LocalServer => {
    const s = getServer()
    if (!s) throw new LlmError('E_NO_KEY', 'No local model server is running.')
    return s
  }
  const caps = (model: string): ModelCaps | null => {
    const s = getServer()
    return s ? capsOf(s, model) : null
  }
  return createChatBackend({
    id: 'local',
    client: () => getClient(current().baseUrl),
    vision: (model) => caps(model)?.vision ?? false,
    tools: (model) => caps(model)?.tools ?? false,
    // Deterministic by default: local replies vary a lot with sampling.
    params: { defaultTemperature: 0 },
    rateLimitMessage: 'The local model server is busy. Try again in a moment.'
    // No warmup: detection (providers/index refreshLocalModels) already opened the connection.
  })
}

/** Test hook. */
export function resetLocalJsonLevel(): void {
  resetJsonLevels()
}
