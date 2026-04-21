import { loadConfig } from './config'

export type ModelFunction = 'planning' | 'execution' | 'verification'
export type Provider = 'anthropic' | 'openai'

const MODELS: Record<Provider, Record<ModelFunction, string>> = {
  anthropic: {
    planning: 'claude-sonnet-4-6',
    execution: 'claude-sonnet-4-6',
    verification: 'claude-haiku-4-5-20251001',
  },
  openai: {
    planning: 'gpt-5-mini',
    execution: 'gpt-5-mini',
    verification: 'gpt-5-nano',
  },
}

export function getProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env')
}

export function getModel(fn: ModelFunction): string {
  const override = loadConfig().models[fn]
  if (override && override.trim()) return override.trim()
  return MODELS[getProvider()][fn]
}
