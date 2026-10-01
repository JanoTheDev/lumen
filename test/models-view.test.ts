import { describe, it, expect } from 'vitest'
import type { ModelsCatalog } from '../src/shared/channels'
import {
  modelOptions,
  providerOptions,
  roleLine,
  keyLinkFor
} from '../src/renderer/src/panel/settings/sections/models-view'
import {
  KEY_LINKS,
  guessPreset,
  guessProvider,
  looksLikeKey
} from '../src/renderer/src/panel/onboarding/flow'

// Key-shaped strings are built at runtime so no committed literal trips secret scanning.
const gemini = ['AI', 'za', 'Q'.repeat(35)].join('')
const openrouter = ['sk', 'or', 'v1', 'a'.repeat(40)].join('-')
const groq = ['gsk', 'b'.repeat(40)].join('_')

const catalog: ModelsCatalog = {
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      ready: true,
      free: false,
      models: [
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', vision: true, tools: true, priced: true }
      ]
    },
    { id: 'gemini', label: 'Google Gemini (free tier)', ready: false, free: true, models: [] },
    {
      id: 'local',
      label: 'On this PC (Ollama)',
      ready: true,
      free: true,
      models: [
        { id: 'llama3.1:8b', label: 'llama3.1:8b', vision: false, tools: false, priced: true }
      ]
    }
  ],
  local: { kind: 'ollama', baseUrl: 'http://localhost:11434' },
  compatible: null,
  roles: {
    main: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    fast: { provider: 'local', model: 'llama3.1:8b' },
    planning: null,
    vision: null
  },
  localOnly: false
}

describe('models view', () => {
  it('offers only providers that are set up, plus the current pick', () => {
    expect(providerOptions(catalog, 'auto').map((o) => o.value)).toEqual([
      'auto',
      'anthropic',
      'local'
    ])
    expect(providerOptions(catalog, 'gemini').find((o) => o.value === 'gemini')?.label).toMatch(
      /not set up/
    )
  })

  it('names what a model lacks and keeps an unlisted current model', () => {
    const local = catalog.providers[2]
    expect(modelOptions(local, '')[1].label).toBe(
      'llama3.1:8b · no images · no multi-step tasks · free'
    )
    expect(modelOptions(local, 'custom:1b').at(-1)).toEqual({
      value: 'custom:1b',
      label: 'custom:1b'
    })
  })

  it('says what a role uses now', () => {
    expect(roleLine(catalog, 'main')).toBe('Now: Haiku 4.5 (Anthropic (Claude))')
    expect(roleLine(catalog, 'planning')).toMatch(/add a key/)
  })

  it('links to the right key page', () => {
    expect(keyLinkFor('gemini', 'custom', KEY_LINKS)).toBe('https://aistudio.google.com/apikey')
    expect(keyLinkFor('compatible', 'groq', KEY_LINKS)).toBe('https://console.groq.com/keys')
    expect(keyLinkFor('compatible', 'custom', KEY_LINKS)).toBeNull()
  })
})

describe('key guessing', () => {
  it('recognises Gemini and compatible-service keys', () => {
    expect(guessProvider(gemini)).toBe('gemini')
    expect(guessProvider(openrouter)).toBe('compatible')
    expect(guessPreset(openrouter)).toBe('openrouter')
    expect(guessProvider(groq)).toBe('compatible')
    expect(guessPreset(groq)).toBe('groq')
    expect(looksLikeKey('gemini', gemini)).toBe(true)
    expect(looksLikeKey('compatible', groq)).toBe(true)
    expect(looksLikeKey('openai', openrouter)).toBe(true)
    expect(looksLikeKey('gemini', 'short')).toBe(false)
  })
})
