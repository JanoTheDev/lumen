// Any OpenAI-compatible chat-completions service: a preset (base URLs checked against each
// service's docs, 2026-10-01) or a custom base URL, one key (vault provider "compatible", env
// COMPATIBLE_API_KEY), a model per role. Models come from the service's /models list; OpenRouter
// also says which take images and tools, the others get the name heuristic and tools assumed.
import type OpenAI from 'openai'
import { loadOpenAI } from './openai'
import type { CompatiblePreset } from '@shared/config'
import { COMPATIBLE_PRESET_INFO } from '@shared/model-providers'
import { loadConfig } from '../../config'
import { registerModelPrice, type Rate } from '../pricing'
import { createChatBackend, type ChatBackend } from './chat-completions'
import { looksVision } from './local'
import { LlmError } from './types'

export const PRESETS = COMPATIBLE_PRESET_INFO

export const COMPATIBLE_ENV = 'COMPATIBLE_API_KEY'

export interface CompatibleSettings {
  preset: CompatiblePreset
  label: string
  /** No trailing slash; '' when a custom preset has no URL yet. */
  baseUrl: string
  /** Default model for roles that pick this service without naming one. */
  model: string
}

export function compatibleSettings(): CompatibleSettings | null {
  const c = loadConfig().models.compatible
  if (!c) return null
  const preset = c.preset === 'custom' ? null : PRESETS[c.preset]
  const baseUrl = (preset?.baseUrl ?? c.baseUrl ?? '').replace(/\/+$/, '')
  return {
    preset: c.preset,
    label: preset?.label ?? 'OpenAI-compatible',
    baseUrl,
    model: c.model?.trim() ?? ''
  }
}

/** Key, base URL and a default model: roles can use the service. */
export function compatibleReady(): boolean {
  const s = compatibleSettings()
  return !!(s?.baseUrl && s.model && process.env[COMPATIBLE_ENV])
}

// ---- model list (cached per base URL + key) ----

export interface RemoteModel {
  id: string
  vision: boolean
  tools: boolean
  /** USD per million tokens, when the service lists prices (OpenRouter). */
  price?: Rate
}

interface OpenRouterModel {
  id?: string
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
  /** USD per token, as decimal strings. */
  pricing?: Record<string, unknown>
}

/** OpenRouter's per-token prices as a per-million rate, or undefined when not usable. */
export function priceOf(pricing: Record<string, unknown> | undefined): Rate | undefined {
  if (!pricing) return undefined
  const perM = (key: string): number | undefined => {
    const v = Number(pricing[key])
    return pricing[key] !== undefined && pricing[key] !== '' && Number.isFinite(v) && v >= 0
      ? Math.round(v * 1e6 * 1e6) / 1e6
      : undefined
  }
  const input = perM('prompt')
  const output = perM('completion')
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cacheRead: perM('input_cache_read') ?? input,
    cacheWrite: perM('input_cache_write') ?? input
  }
}

/** Parses a /models reply; OpenRouter entries carry modalities and supported parameters. */
export function parseModelList(body: unknown): RemoteModel[] {
  const data = (body as { data?: OpenRouterModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id!,
      vision: m.architecture?.input_modalities
        ? m.architecture.input_modalities.includes('image')
        : looksVisionRemote(m.id!),
      tools: m.supported_parameters ? m.supported_parameters.includes('tools') : true,
      ...(priceOf(m.pricing) ? { price: priceOf(m.pricing) } : {})
    }))
}

// Hosted families that take images, by name (local heuristic plus hosted-only names).
const HOSTED_VISION_RE =
  /(gpt-4o|gpt-4\.1|gpt-5|pixtral|mistral-(small|medium)|llama-4|gemini|claude|-vl|vision)/i

export function looksVisionRemote(id: string): boolean {
  return looksVision(id) || HOSTED_VISION_RE.test(id)
}

let cache: { key: string; at: number; models: RemoteModel[] } | null = null
const LIST_TTL_MS = 10 * 60_000

/** The service's models, or [] when it cannot be reached. Never throws. */
export async function listCompatibleModels(
  force = false,
  fetchFn: typeof fetch = fetch
): Promise<RemoteModel[]> {
  const s = compatibleSettings()
  const apiKey = process.env[COMPATIBLE_ENV]
  if (!s?.baseUrl || !apiKey) return []
  const cacheKey = `${s.baseUrl}|${apiKey.slice(-6)}`
  if (!force && cache?.key === cacheKey && Date.now() - cache.at < LIST_TTL_MS) return cache.models
  try {
    const res = await fetchFn(`${s.baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return []
    const models = parseModelList(await res.json())
    for (const m of models) if (m.price) registerModelPrice(m.id, m.price)
    cache = { key: cacheKey, at: Date.now(), models }
    return models
  } catch {
    return []
  }
}

function known(model: string): RemoteModel | undefined {
  return cache?.models.find((m) => m.id === model)
}

// ---- provider ----

let client: { url: string; key: string; sdk: OpenAI } | null = null

async function sdk(): Promise<OpenAI> {
  const { default: OpenAI } = await loadOpenAI()
  const s = compatibleSettings()
  const key = process.env[COMPATIBLE_ENV]
  if (!s?.baseUrl || !key)
    throw new LlmError('E_NO_KEY', 'The OpenAI-compatible service has no key or address yet.')
  if (client?.url !== s.baseUrl || client.key !== key)
    client = {
      url: s.baseUrl,
      key,
      sdk: new OpenAI({ apiKey: key, baseURL: s.baseUrl, maxRetries: 1 })
    }
  return client.sdk
}

export function createCompatibleProvider(
  getClient: () => OpenAI | Promise<OpenAI> = sdk
): ChatBackend {
  return createChatBackend({
    id: 'compatible',
    client: getClient,
    vision: (model) => known(model)?.vision ?? looksVisionRemote(model),
    tools: (model) => known(model)?.tools ?? true,
    rateLimitMessage: 'The AI service says too many requests. Try again in a minute.',
    warmup: async () => {
      await listCompatibleModels()
    }
  })
}
