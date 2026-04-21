// test/model-router.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getModel, getProvider } from '../src/main/model-router'

describe('model-router', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns anthropic models when ANTHROPIC_API_KEY set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(getModel('planning')).toBe('claude-sonnet-4-6')
    expect(getModel('verification')).toBe('claude-haiku-4-5-20251001')
  })

  it('returns openai models when only OPENAI_API_KEY set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    expect(getModel('planning')).toBe('gpt-5-mini')
    expect(getModel('verification')).toBe('gpt-5-nano')
  })

  it('prefers anthropic when both keys present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    expect(getProvider()).toBe('anthropic')
  })

  it('throws when no keys present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(() => getProvider()).toThrow('No API key')
  })
})
