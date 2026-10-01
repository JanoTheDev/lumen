// Provider registry: one lazily created provider (and SDK client) per backend, reused for the
// app's lifetime. Every call's usage is reported to the usage listener, and every message
// (user turn, history, tool results) has its secrets redacted before it leaves the app.
import { redactForModel } from '../../actions/redact'
import { loadConfig } from '../../config'
import { markFreeModel } from '../pricing'
import {
  AUTO_ORDER,
  isLocalOnly,
  providerReady,
  resolveRole,
  type Role,
  type RoleModel
} from '../models'
import { createAnthropicProvider } from './anthropic'
import { createCompatibleProvider } from './compatible'
import { createGeminiProvider } from './gemini'
import { createLocalProvider, localServer, refreshLocal, type LocalServer } from './local'
import { createOpenAIProvider } from './openai'
import {
  LlmError,
  type AgentMessage,
  type ChatChunk,
  type ChatRequest,
  type LlmProvider,
  type ProviderId,
  type ToolContent,
  type Usage
} from './types'

export * from './types'

type UsageListener = (model: string, usage: Usage, hasImage: boolean) => void

const instances: Partial<Record<ProviderId, LlmProvider>> = {}
let listener: UsageListener = () => {}

/** Receives the usage of every completed call (pricing + cost tracking). */
export function onUsage(fn: UsageListener): void {
  listener = fn
}

/** A cloud provider has its key (and is not set aside by Local only). */
export function hasKey(id: ProviderId): boolean {
  return id !== 'local' && providerReady(id)
}

/** Any model can be called: a cloud key or a detected local server. */
export function hasAnyModel(): boolean {
  return AUTO_ORDER.some(providerReady)
}

/**
 * The model of a role takes images (vision verify, refine, screen description and labels use
 * `fast`, the zoom pass `vision-refine`).
 */
export function hasVisionModel(role: Role = 'fast'): boolean {
  try {
    const { provider, model } = resolveRole(role)
    return providerFor(provider).supportsVision?.(model) ?? true
  } catch {
    return false
  }
}

/** Some role is set to a local model, or local is the preferred / only backend. */
function wantsLocal(): boolean {
  const m = loadConfig().models
  if (m.provider === 'local' || isLocalOnly()) return true
  if (Object.values(m.roles ?? {}).some((c) => c?.provider === 'local')) return true
  return !AUTO_ORDER.some((p) => p !== 'local' && providerReady(p))
}

/**
 * Detects a local server (config models.localUrl/localModel, else Ollama then LM Studio).
 * Cached; cheap enough to await before a turn. Skipped when a cloud key serves everything
 * and nothing asks for a local model (unless forced, e.g. by Settings).
 */
export function refreshLocalModels(force = false): Promise<LocalServer | null> {
  const m = loadConfig().models
  if (!force && !wantsLocal()) return Promise.resolve(localServer())
  return refreshLocal({ url: m.localUrl || undefined, model: m.localModel || undefined, force })
}

function create(id: ProviderId): LlmProvider {
  if (id === 'anthropic') return createAnthropicProvider()
  if (id === 'openai') return createOpenAIProvider()
  if (id === 'gemini') return createGeminiProvider()
  if (id === 'compatible') return createCompatibleProvider()
  if (id === 'local') return createLocalProvider()
  throw new LlmError('E_NO_KEY', `Provider "${id}" is not available.`)
}

/**
 * Calls through these cost nothing: local servers, and Gemini unless the user said their key
 * has billing on (`models.geminiPaid`; then the paid table rates apply).
 */
function isFreeProvider(id: ProviderId): boolean {
  if (id === 'local') return true
  return id === 'gemini' && loadConfig().models.geminiPaid !== true
}

let deterministic = false

/**
 * Eval runs: temperature 0 on every call (dropped by providers for models that reject sampling
 * parameters, e.g. Sonnet/Opus 5.5). Neither API takes a seed, so runs are near, not fully,
 * repeatable.
 */
export function setDeterministic(on: boolean): void {
  deterministic = on
}

const redactContent = (c: ToolContent): ToolContent =>
  c.type === 'text' ? { ...c, text: redactForModel(c.text) } : c

function redactAgentMessage(m: AgentMessage): AgentMessage {
  if (m.role === 'assistant') return { ...m, text: redactForModel(m.text) }
  return {
    ...m,
    content: m.content.map((c) =>
      c.type === 'tool_result' ? { ...c, content: c.content.map(redactContent) } : redactContent(c)
    )
  }
}

/**
 * Model input: secrets (API keys, cards, IBANs, passwords, codes) in the user turn, history,
 * screen text and tool results become `[redacted:<kind>]`. System prompts are Lumen's own text
 * and stay byte-identical for the prompt cache.
 */
export function prepareRequest<R extends ChatRequest>(req: R): R {
  return {
    ...req,
    messages: req.messages.map((m) => ({ ...m, content: redactForModel(m.content) })),
    ...(deterministic ? { temperature: 0 } : {})
  }
}

function withUsage(inner: LlmProvider): LlmProvider {
  const usageListener: UsageListener = (model, usage, hasImage) => {
    if (inner.id === 'local' || inner.id === 'gemini')
      markFreeModel(model, isFreeProvider(inner.id))
    listener(model, usage, hasImage)
  }
  return {
    id: inner.id,
    async complete(req, signal) {
      const res = await inner.complete(prepareRequest(req), signal)
      usageListener(res.model, res.usage, !!req.images?.length)
      return res
    },
    async *stream(req, signal): AsyncIterable<ChatChunk> {
      for await (const chunk of inner.stream(prepareRequest(req), signal)) {
        if (chunk.type === 'done')
          usageListener(chunk.result.model, chunk.result.usage, !!req.images?.length)
        yield chunk
      }
    },
    warmup: () => inner.warmup(),
    ...(inner.supportsTools ? { supportsTools: (m: string) => inner.supportsTools!(m) } : {}),
    ...(inner.supportsVision ? { supportsVision: (m: string) => inner.supportsVision!(m) } : {}),
    ...(inner.toolTurn
      ? {
          async toolTurn(req, signal) {
            const res = await inner.toolTurn!(
              { ...req, messages: req.messages.map(redactAgentMessage) },
              signal
            )
            const hasImage = req.messages.some(
              (m) =>
                m.role === 'user' &&
                m.content.some(
                  (c) =>
                    c.type === 'image' ||
                    (c.type === 'tool_result' && c.content.some((x) => x.type === 'image'))
                )
            )
            usageListener(res.model, res.usage, hasImage)
            return res
          }
        }
      : {})
  }
}

export function providerFor(id: ProviderId): LlmProvider {
  return (instances[id] ??= withUsage(create(id)))
}

/**
 * Provider, model and effort for a role. `llm.toolTurn` is left out when the role's model has
 * no tool calling, so agent mode takes its one-call fallback only then.
 */
export function getProvider(role: Role): RoleModel & { llm: LlmProvider } {
  const resolved = resolveRole(role)
  const llm = providerFor(resolved.provider)
  if (llm.toolTurn && llm.supportsTools && !llm.supportsTools(resolved.model))
    return { ...resolved, llm: { ...llm, toolTurn: undefined } }
  return { ...resolved, llm }
}

/** Test hook: replace (or with null, reset) the provider used for an id. */
export function setProvider(id: ProviderId, provider: LlmProvider | null): void {
  if (provider) instances[id] = withUsage(provider)
  else delete instances[id]
}

const WARM_INTERVAL_MS = 60_000
let lastWarm = 0

/** Opens the SDK connection pool for every provider that has a key. Never throws. */
export function warmupProviders(now = Date.now()): void {
  if (now - lastWarm < WARM_INTERVAL_MS) return
  lastWarm = now
  for (const id of AUTO_ORDER) {
    if (id !== 'local' && hasKey(id)) void providerFor(id).warmup()
  }
  void refreshLocalModels()
}
