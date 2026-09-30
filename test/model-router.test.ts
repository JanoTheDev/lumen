// test/model-router.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getModel, getProvider } from '../src/main/model-router'
import { setConfigDir, saveConfig } from '../src/main/config'

let dir: string

describe('model-router', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-overlay-router-'))
    setConfigDir(dir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns anthropic models when ANTHROPIC_API_KEY set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(getModel('planning')).toBe('claude-sonnet-4-6')
    expect(getModel('main')).toBe('claude-sonnet-4-6')
    expect(getModel('verify')).toBe('claude-haiku-4-5-20251001')
  })

  it('returns openai models when only OPENAI_API_KEY set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    expect(getModel('planning')).toBe('gpt-5-mini')
    expect(getModel('verify')).toBe('gpt-5-nano')
  })

  it('prefers anthropic when both keys present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    expect(getProvider()).toBe('anthropic')
  })

  it('honours models.provider when that key is present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    saveConfig({ models: { provider: 'openai' } })
    expect(getProvider()).toBe('openai')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(getProvider()).toBe('anthropic')
  })

  it('uses per-role overrides from config', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    saveConfig({ models: { main: 'claude-opus-4-7' } })
    expect(getModel('main')).toBe('claude-opus-4-7')
    expect(getModel('planning')).toBe('claude-sonnet-4-6')
  })

  it('throws when no keys present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(() => getProvider()).toThrow('No API key')
  })
})
