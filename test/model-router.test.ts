// test/model-router.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computerUseModel, getModel, getProvider, isReasoningModel, reasoningParams } from '../src/main/ai/router'
import { usageCost } from '../src/main/ai/pricing'
import { addToHistory, clearHistory, historyMessages } from '../src/main/ai/history'
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

  it('computer use keeps a Claude model even when main is overridden to another provider', () => {
    saveConfig({ models: { main: 'gpt-5' } })
    expect(computerUseModel()).toBe('claude-sonnet-4-6')
    saveConfig({ models: { main: 'claude-opus-4-7' } })
    expect(computerUseModel()).toBe('claude-opus-4-7')
  })
})

describe('reasoning params', () => {
  it('only reasoning models get reasoning_effort', () => {
    expect(isReasoningModel('gpt-5-mini')).toBe(true)
    expect(isReasoningModel('o4-mini')).toBe(true)
    expect(isReasoningModel('gpt-4o')).toBe(false)
    expect(isReasoningModel('claude-sonnet-4-6')).toBe(false)
    expect(reasoningParams('gpt-5-nano')).toEqual({ reasoning_effort: 'minimal' })
    expect(reasoningParams('o3')).toEqual({ reasoning_effort: 'low' })
    expect(reasoningParams('gpt-4o')).toEqual({})
  })
})

describe('pricing', () => {
  it('prices Haiku 4.5 at $1 / $5 per MTok', () => {
    const c = usageCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)
    expect(c.input).toBeCloseTo(1)
    expect(c.output).toBeCloseTo(5)
  })
})

describe('history', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-overlay-history-'))
    setConfigDir(dir)
    clearHistory()
  })
  afterEach(() => {
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends at most historyExchanges exchanges', () => {
    saveConfig({ historyExchanges: 2 })
    for (let i = 1; i <= 4; i++) addToHistory(`q${i}`, `a${i}`)
    expect(historyMessages().map((m) => m.content)).toEqual(['q3', 'a3', 'q4', 'a4'])
  })

  it('stores and sends nothing when history is disabled', () => {
    saveConfig({ historyEnabled: false })
    addToHistory('q', 'a')
    expect(historyMessages()).toEqual([])
    saveConfig({ historyEnabled: true })
    expect(historyMessages()).toEqual([])
  })
})
