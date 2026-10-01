import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  activeProvider,
  modelLabel,
  providerOfModel,
  resolveRole,
  type Role
} from '../../src/main/ai/models'
import { isReasoningModel, reasoningEffort } from '../../src/main/ai/providers/openai'
import { addToHistory, clearHistory, historyMessages } from '../../src/main/ai/history'
import { setConfigDir, saveConfig } from '../../src/main/config'

let dir: string

function keys(anthropic: boolean, openai: boolean): void {
  vi.stubEnv('ANTHROPIC_API_KEY', anthropic ? 'a-key' : '')
  vi.stubEnv('OPENAI_API_KEY', openai ? 'o-key' : '')
}

const model = (role: Role): string => resolveRole(role).model

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-models-'))
  setConfigDir(dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('role defaults per key combo', () => {
  it('anthropic only: Haiku for fast, Sonnet 5.5 for the rest', () => {
    keys(true, false)
    expect(model('fast')).toBe('claude-haiku-4-5')
    expect(model('main')).toBe('claude-sonnet-5-5')
    expect(model('planning')).toBe('claude-sonnet-5-5')
    expect(model('vision-refine')).toBe('claude-sonnet-5-5')
    expect(resolveRole('main').provider).toBe('anthropic')
  })

  it('openai only: every role works on the one key', () => {
    keys(false, true)
    expect(model('fast')).toBe('gpt-5-nano')
    expect(model('main')).toBe('gpt-5-mini')
    expect(model('planning')).toBe('gpt-5-mini')
    expect(model('vision-refine')).toBe('gpt-5-mini')
    expect(resolveRole('vision-refine').provider).toBe('openai')
  })

  it('both keys: anthropic unless the config picks openai', () => {
    keys(true, true)
    expect(activeProvider()).toBe('anthropic')
    saveConfig({ models: { provider: 'openai' } })
    expect(activeProvider()).toBe('openai')
    expect(model('main')).toBe('gpt-5-mini')
  })

  it('provider choice without its key falls back to the key that exists', () => {
    keys(true, false)
    saveConfig({ models: { provider: 'openai' } })
    expect(activeProvider()).toBe('anthropic')
  })

  it('local (not available yet) falls back to a cloud key', () => {
    keys(false, true)
    saveConfig({ models: { provider: 'local' } })
    expect(resolveRole('main')).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' })
  })

  it('throws a clear error with no keys', () => {
    keys(false, false)
    expect(() => resolveRole('main')).toThrow('No API key')
  })
})

describe('overrides', () => {
  it('applies per-role overrides; vision-refine follows main', () => {
    keys(true, false)
    saveConfig({ models: { main: 'claude-opus-5-5', planning: 'claude-opus-5-5' } })
    expect(model('main')).toBe('claude-opus-5-5')
    expect(model('vision-refine')).toBe('claude-opus-5-5')
    expect(model('planning')).toBe('claude-opus-5-5')
    expect(model('fast')).toBe('claude-haiku-4-5')
  })

  it('maps the verify override to the fast role; fast wins over verify', () => {
    keys(true, false)
    saveConfig({ models: { verify: 'claude-sonnet-5-5' } })
    expect(model('fast')).toBe('claude-sonnet-5-5')
    saveConfig({ models: { fast: 'claude-haiku-4-5', verify: 'claude-sonnet-5-5' } })
    expect(model('fast')).toBe('claude-haiku-4-5')
  })

  it('an override for the other provider is used when that key exists', () => {
    keys(true, true)
    saveConfig({ models: { fast: 'gpt-5-nano' } })
    expect(resolveRole('fast')).toMatchObject({ provider: 'openai', model: 'gpt-5-nano' })
    expect(resolveRole('main').provider).toBe('anthropic')
  })

  it('an override whose key is missing is ignored instead of failing', () => {
    keys(false, true)
    saveConfig({ models: { main: 'claude-opus-5-5' } })
    expect(resolveRole('main')).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' })
  })

  it('blank overrides use the defaults', () => {
    keys(true, false)
    saveConfig({ models: { main: '' } })
    expect(model('main')).toBe('claude-sonnet-5-5')
  })
})

describe('model helpers', () => {
  it('maps model ids to providers', () => {
    expect(providerOfModel('claude-haiku-4-5')).toBe('anthropic')
    expect(providerOfModel('gpt-5-mini')).toBe('openai')
    expect(providerOfModel('o3')).toBe('openai')
    expect(providerOfModel('llama3.2-vision')).toBeNull()
  })

  it('labels models for the UI', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('gpt-5-mini')).toBe('GPT-5-mini')
  })

  it('only reasoning models get a reasoning effort', () => {
    expect(isReasoningModel('gpt-5-mini')).toBe(true)
    expect(isReasoningModel('o4-mini')).toBe(true)
    expect(isReasoningModel('gpt-4o')).toBe(false)
    expect(isReasoningModel('claude-sonnet-4-6')).toBe(false)
    expect(reasoningEffort('gpt-5-nano')).toBe('minimal')
    expect(reasoningEffort('o3')).toBe('low')
    expect(reasoningEffort('gpt-4o')).toBeUndefined()
  })
})

describe('history', () => {
  beforeEach(() => clearHistory())

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
