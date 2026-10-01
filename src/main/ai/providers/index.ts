// Provider registry: one lazily created provider (and SDK client) per backend, reused for the
// app's lifetime. Every call's usage is reported to the usage listener, and every message
// (user turn, history, tool results) has its secrets redacted before it leaves the app.
import { redactForModel } from '../../actions/redact'
import { loadConfig } from '../../config'
import { markFreeModel } from '../pricing'
import { resolveRole, type Role, type RoleModel } from '../models'
import { createAnthropicProvider } from './anthropic'
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

export function hasKey(id: ProviderId): boolean {
  if (id === 'anthropic') return !!process.env.ANTHROPIC_API_KEY
  if (id === 'openai') return !!process.env.OPENAI_API_KEY
  return false
}

/** Any model can be called: a cloud key or a detected local server. */
export function hasAnyModel(): boolean {
  return hasKey('anthropic') || hasKey('openai') || !!localServer()
}

/** A model that takes images is available (vision verify, refine, screen description). */
export function hasVisionModel(): boolean {
  return hasKey('anthropic') || hasKey('openai') || !!localServer()?.vision
}

/**
 * Detects a local server (config models.localUrl/localModel, else Ollama then LM Studio).
 * Cached; cheap enough to await before a turn. Skipped when a cloud key serves everything
 * and the user did not pick "local".
 */
export function refreshLocalModels(force = false): Promise<LocalServer | null> {
  const m = loadConfig().models
  if (m.provider !== 'local' && (hasKey('anthropic') || hasKey('openai')))
    return Promise.resolve(localServer())
  return refreshLocal({ url: m.localUrl || undefined, model: m.localModel || undefined, force })
}

function create(id: ProviderId): LlmProvider {
  if (id === 'anthropic') return createAnthropicProvider()
  if (id === 'openai') return createOpenAIProvider()
  if (id === 'local') return createLocalProvider()
  throw new LlmError('E_NO_KEY', `Provider "${id}" is not available.`)
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
    if (inner.id === 'local') markFreeModel(model)
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

/** Provider, model and effort for a role. */
export function getProvider(role: Role): RoleModel & { llm: LlmProvider } {
  const resolved = resolveRole(role)
  return { ...resolved, llm: providerFor(resolved.provider) }
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
  for (const id of ['anthropic', 'openai'] as const) {
    if (hasKey(id)) void providerFor(id).warmup()
  }
  void refreshLocalModels()
}
