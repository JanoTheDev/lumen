import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { activeProvider, modelLabel, providerReady, resolveRole } from '../../src/main/ai/models'
import { setLocalServer, type LocalServer } from '../../src/main/ai/providers/local'
import { getProvider, hasAnyModel, hasVisionModel } from '../../src/main/ai/providers'
import { setConfigDir, saveConfig } from '../../src/main/config'

let dir: string

// Placeholder values only: providers just check that a key is present.
function keys(
  set: Partial<Record<'anthropic' | 'openai' | 'gemini' | 'compatible', boolean>>
): void {
  vi.stubEnv('ANTHROPIC_API_KEY', set.anthropic ? 'a-key' : '')
  vi.stubEnv('OPENAI_API_KEY', set.openai ? 'o-key' : '')
  vi.stubEnv('GEMINI_API_KEY', set.gemini ? 'g-key' : '')
  vi.stubEnv('COMPATIBLE_API_KEY', set.compatible ? 'c-key' : '')
}

const server = (over: Partial<LocalServer> = {}): LocalServer => ({
  kind: 'ollama',
  baseUrl: 'http://localhost:11434',
  models: ['qwen3.5:9b', 'llama3.1:8b'],
  model: 'qwen3.5:9b',
  vision: true,
  tools: true,
  info: {
    'qwen3.5:9b': { vision: true, tools: true },
    'llama3.1:8b': { vision: false, tools: false }
  },
  ...over
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-providers-'))
  setConfigDir(dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  setLocalServer(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setLocalServer(null)
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('gemini', () => {
  it('a Gemini key alone powers every role: Flash-Lite for fast, Flash for the rest', () => {
    keys({ gemini: true })
    expect(activeProvider()).toBe('gemini')
    expect(resolveRole('fast')).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite'
    })
    expect(resolveRole('main').model).toBe('gemini-3.8-flash')
    expect(resolveRole('planning').model).toBe('gemini-3.8-flash')
    expect(resolveRole('vision-refine').model).toBe('gemini-3.8-flash')
    expect(hasAnyModel()).toBe(true)
    expect(hasVisionModel()).toBe(true)
  })

  it('auto prefers a paid key; the config can prefer Gemini', () => {
    keys({ anthropic: true, gemini: true })
    expect(activeProvider()).toBe('anthropic')
    saveConfig({ models: { provider: 'gemini' } })
    expect(activeProvider()).toBe('gemini')
  })

  it('labels Gemini models', () => {
    expect(modelLabel('gemini-3.8-flash')).toBe('Gemini 3.8 Flash')
    expect(modelLabel('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite')
  })
})

describe('OpenAI-compatible service', () => {
  it('needs a key, an address and a default model', () => {
    keys({ compatible: true })
    expect(providerReady('compatible')).toBe(false)
    saveConfig({ models: { compatible: { preset: 'groq' } } })
    expect(providerReady('compatible')).toBe(false)
    saveConfig({ models: { compatible: { preset: 'groq', model: 'llama-3.3-70b-versatile' } } })
    expect(providerReady('compatible')).toBe(true)
    expect(resolveRole('main')).toMatchObject({
      provider: 'compatible',
      model: 'llama-3.3-70b-versatile'
    })
  })

  it('a custom preset needs its own address', () => {
    keys({ compatible: true })
    saveConfig({ models: { compatible: { preset: 'custom', model: 'm1' } } })
    expect(providerReady('compatible')).toBe(false)
    saveConfig({
      models: { compatible: { preset: 'custom', baseUrl: 'https://llm.example/v1', model: 'm1' } }
    })
    expect(providerReady('compatible')).toBe(true)
  })
})

describe('per-role choice', () => {
  it('each role can use its own provider and model', () => {
    keys({ anthropic: true, gemini: true })
    saveConfig({
      models: {
        roles: {
          fast: { provider: 'gemini', model: '' },
          planning: { provider: 'anthropic', model: 'claude-opus-5-5' }
        }
      }
    })
    expect(resolveRole('fast')).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite'
    })
    expect(resolveRole('planning')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5'
    })
    expect(resolveRole('main')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  })

  it('the close-look pass follows the main choice unless it has its own', () => {
    keys({ anthropic: true, gemini: true })
    saveConfig({ models: { roles: { main: { provider: 'gemini' } } } })
    expect(resolveRole('vision-refine').provider).toBe('gemini')
    saveConfig({ models: { roles: { vision: { provider: 'anthropic' } } } })
    expect(resolveRole('vision-refine').provider).toBe('anthropic')
  })

  it('a role set to a provider without a key falls back to the default', () => {
    keys({ openai: true })
    saveConfig({ models: { roles: { main: { provider: 'gemini' } } } })
    expect(resolveRole('main')).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' })
  })

  it('a role can pick a local model next to a cloud default', () => {
    keys({ anthropic: true })
    setLocalServer(server())
    saveConfig({ models: { roles: { fast: { provider: 'local', model: 'llama3.1:8b' } } } })
    expect(resolveRole('fast')).toMatchObject({ provider: 'local', model: 'llama3.1:8b' })
    // llama3.1 reports no vision: checks that need images say so.
    expect(hasVisionModel('fast')).toBe(false)
    expect(hasVisionModel('main')).toBe(true)
  })
})

describe('local models', () => {
  it('agent mode keeps tool use only for a local model that has it', () => {
    keys({})
    setLocalServer(server())
    expect(getProvider('main').llm.toolTurn).toBeTypeOf('function')
    setLocalServer(server({ model: 'llama3.1:8b', vision: false, tools: false }))
    expect(getProvider('main').llm.toolTurn).toBeUndefined()
  })
})

describe('local only', () => {
  it('never resolves to a cloud provider', () => {
    keys({ anthropic: true, gemini: true })
    saveConfig({ models: { localOnly: true, roles: { main: { provider: 'anthropic' } } } })
    expect(providerReady('anthropic')).toBe(false)
    expect(() => activeProvider()).toThrow(/Local only/)
    setLocalServer(server())
    expect(resolveRole('main')).toMatchObject({ provider: 'local', model: 'qwen3.5:9b' })
    expect(resolveRole('fast').provider).toBe('local')
  })
})
