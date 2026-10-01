// Provider registry: one lazily created provider (and SDK client) per backend, reused for the
// app's lifetime. Every call's usage is reported to the usage listener.
import { resolveRole, type Role, type RoleModel } from '../models'
import { createAnthropicProvider } from './anthropic'
import { createOpenAIProvider } from './openai'
import { LlmError, type ChatChunk, type LlmProvider, type ProviderId, type Usage } from './types'

export * from './types'

type UsageListener = (model: string, usage: Usage, hasImage: boolean) => void

const instances: Partial<Record<ProviderId, LlmProvider>> = {}
let usageListener: UsageListener = () => {}

/** Receives the usage of every completed call (pricing + cost tracking). */
export function onUsage(fn: UsageListener): void {
  usageListener = fn
}

export function hasKey(id: ProviderId): boolean {
  if (id === 'anthropic') return !!process.env.ANTHROPIC_API_KEY
  if (id === 'openai') return !!process.env.OPENAI_API_KEY
  return false
}

function create(id: ProviderId): LlmProvider {
  if (id === 'anthropic') return createAnthropicProvider()
  if (id === 'openai') return createOpenAIProvider()
  throw new LlmError('E_NO_KEY', `Provider "${id}" is not available yet.`)
}

function withUsage(inner: LlmProvider): LlmProvider {
  return {
    id: inner.id,
    async complete(req, signal) {
      const res = await inner.complete(req, signal)
      usageListener(res.model, res.usage, !!req.images?.length)
      return res
    },
    async *stream(req, signal): AsyncIterable<ChatChunk> {
      for await (const chunk of inner.stream(req, signal)) {
        if (chunk.type === 'done')
          usageListener(chunk.result.model, chunk.result.usage, !!req.images?.length)
        yield chunk
      }
    },
    warmup: () => inner.warmup()
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
}
