import { loadConfig } from '../config'

export type ModelFunction = 'planning' | 'main' | 'fast' | 'verify'
export type Provider = 'anthropic' | 'openai'

const MODELS: Record<Provider, Record<ModelFunction, string>> = {
  anthropic: {
    planning: 'claude-sonnet-4-6',
    main: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5-20251001',
    verify: 'claude-haiku-4-5-20251001',
  },
  openai: {
    planning: 'gpt-5-mini',
    main: 'gpt-5-mini',
    fast: 'gpt-5-nano',
    verify: 'gpt-5-nano',
  },
}

export function getProvider(): Provider {
  const preferred = loadConfig().models.provider
  if (preferred === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (preferred === 'openai' && process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env')
}

export function getModel(fn: ModelFunction): string {
  const override = loadConfig().models[fn]
  if (override && override.trim()) return override.trim()
  return MODELS[getProvider()][fn]
}

/** Computer Use is Anthropic-only: the main override applies only when it is a Claude model. */
export function computerUseModel(): string {
  const override = loadConfig().models.main?.trim()
  return override && override.startsWith('claude-') ? override : MODELS.anthropic.main
}

/** gpt-5* and o-series models take `reasoning_effort`; other chat models reject it. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model)
}

/** Lowest reasoning effort the model accepts, or nothing for non-reasoning models. */
export function reasoningParams(model: string): { reasoning_effort?: 'minimal' | 'low' } {
  if (!isReasoningModel(model)) return {}
  return { reasoning_effort: /^gpt-5/i.test(model) ? 'minimal' : 'low' }
}
