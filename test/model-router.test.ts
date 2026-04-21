import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getModel, getProvider } from '../src/main/model-router'

describe('model-router', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('returns anthropic models when ANTHROPIC_API_KEY set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.OPENAI_API_KEY
    expect(getModel('planning')).toBe('claude-sonnet-4-6')
    expect(getModel('verification')).toBe('claude-haiku-4-5-20251001')
  })

  it('returns openai models when only OPENAI_API_KEY set', () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
    expect(getModel('planning')).toBe('gpt-5-mini')
    expect(getModel('verification')).toBe('gpt-5-nano')
  })

  it('prefers anthropic when both keys present', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.OPENAI_API_KEY = 'test-key'
    expect(getProvider()).toBe('anthropic')
  })

  it('throws when no keys present', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    expect(() => getProvider()).toThrow('No API key')
  })
})
