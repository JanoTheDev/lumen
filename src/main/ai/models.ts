// Model registry: which provider + model + effort serves each role. One key is enough for
// every role. Settings → Models & keys can give each role its own provider and model
// (config.models.roles); older per-role model ids (models.main / fast / planning / verify) still
// apply when their provider is usable. Without a key, a running local server (Ollama / LM
// Studio, detected) serves every role. "Local only" never resolves to a cloud provider.
import { localUrlAllowed } from '@shared/local-url'
import { loadConfig } from '../config'
import { compatibleReady, compatibleSettings, COMPATIBLE_ENV } from './providers/compatible'
import { GEMINI_ENV } from './providers/gemini'
import { localServer } from './providers/local'
import type { Effort, ProviderId } from './providers/types'

/**
 * fast: routing, verification, short answers. main: answers, guides, grounding.
 * planning: multi-step and agent runs. vision-refine: the zoom-crop second pass.
 */
export type Role = 'fast' | 'main' | 'planning' | 'vision-refine'

/** Providers with built-in default models. */
export type DefaultsProvider = 'anthropic' | 'openai' | 'gemini'

export const DEFAULT_MODELS: Record<DefaultsProvider, Record<Role, string>> = {
  anthropic: {
    fast: 'claude-haiku-4-5',
    main: 'claude-sonnet-5-5',
    planning: 'claude-sonnet-5-5',
    'vision-refine': 'claude-sonnet-5-5'
  },
  openai: {
    fast: 'gpt-5-nano',
    main: 'gpt-5-mini',
    planning: 'gpt-5-mini',
    'vision-refine': 'gpt-5-mini'
  },
  // Free tier (2026-10-01): quotas are per model, so the fast role's many small calls use
  // Flash-Lite and leave Flash's quota to answers.
  gemini: {
    fast: 'gemini-3.5-flash-lite',
    main: 'gemini-3.8-flash',
    planning: 'gemini-3.8-flash',
    'vision-refine': 'gemini-3.8-flash'
  }
}

/** Order `auto` tries providers in. */
export const AUTO_ORDER: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'compatible',
  'local'
]

const ROLE_EFFORT: Record<Role, Effort> = {
  fast: 'low',
  main: 'low',
  planning: 'low',
  'vision-refine': 'low'
}

/** The Settings name of each role (config.models.roles keys). */
export const ROLE_CONFIG_KEY = {
  fast: 'fast',
  main: 'main',
  planning: 'planning',
  'vision-refine': 'vision'
} as const satisfies Record<Role, string>

export interface RoleModel {
  role: Role
  provider: ProviderId
  model: string
  effort: Effort
}

export function isLocalOnly(): boolean {
  return loadConfig().models.localOnly === true
}

/** The user has read the Gemini free-tier privacy note (Settings or onboarding). */
export function geminiAcked(): boolean {
  return loadConfig().models.geminiAck === true
}

/**
 * A local server was found and may be used: with Local only on it must be on this PC, or on
 * the home network when models.localLan is on.
 */
function localUsable(): boolean {
  const server = localServer()
  if (!server) return false
  if (!isLocalOnly()) return true
  return localUrlAllowed(server.baseUrl, loadConfig().models.localLan === true)
}

/** The provider can take calls now: a key (or a running local server), and not cut off by Local only. */
export function providerReady(p: ProviderId): boolean {
  if (p === 'local') return localUsable()
  if (isLocalOnly()) return false
  if (p === 'anthropic') return !!process.env.ANTHROPIC_API_KEY
  if (p === 'openai') return !!process.env.OPENAI_API_KEY
  // Gemini's free tier may use prompts for training and human review: only after the note.
  if (p === 'gemini') return !!process.env[GEMINI_ENV] && geminiAcked()
  return compatibleReady() && !!process.env[COMPATIBLE_ENV]
}

/** The provider a model id belongs to, or null when it is not recognisable. */
export function providerOfModel(model: string): DefaultsProvider | null {
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^(gpt-|chatgpt-|o\d)/i.test(model)) return 'openai'
  if (/^gemini-/i.test(model)) return 'gemini'
  return null
}

/**
 * The provider that serves the defaults: the configured one when usable, else the first usable
 * one in AUTO_ORDER. Local only: the local server or nothing.
 */
export function activeProvider(): ProviderId {
  if (isLocalOnly()) {
    if (localUsable()) return 'local'
    throw new Error('Local only is on, but no local model is running. Start Ollama or LM Studio.')
  }
  const preferred = loadConfig().models.provider
  if (preferred !== 'auto' && providerReady(preferred)) return preferred
  for (const p of AUTO_ORDER) if (providerReady(p)) return p
  throw new Error('No API key found. Add an AI key in Settings, or start Ollama or LM Studio.')
}

/** The model a provider uses for a role when none is picked ('' when it has none). */
export function defaultModel(provider: ProviderId, role: Role): string {
  if (provider === 'local') return localServer()?.model ?? ''
  if (provider === 'compatible') return compatibleSettings()?.model ?? ''
  return DEFAULT_MODELS[provider][role]
}

// Older config keys checked per role, first non-empty wins. `verify` is the v1 name of fast.
const OVERRIDE_KEYS: Record<Role, ('main' | 'fast' | 'planning' | 'verify')[]> = {
  fast: ['fast', 'verify'],
  main: ['main'],
  planning: ['planning'],
  'vision-refine': ['main']
}

function overrideFor(role: Role): string | undefined {
  const m = loadConfig().models
  for (const key of OVERRIDE_KEYS[role]) {
    const value = m[key]?.trim()
    if (value) return value
  }
  return undefined
}

/** The Settings choice for a role; the vision pass follows the main role when it has none. */
function choiceFor(role: Role): { provider: ProviderId | 'auto'; model?: string } | undefined {
  const roles = loadConfig().models.roles
  const own = roles?.[ROLE_CONFIG_KEY[role]]
  if (own || role !== 'vision-refine') return own
  return roles?.main
}

export function resolveRole(role: Role): RoleModel {
  const effort = ROLE_EFFORT[role]
  const choice = choiceFor(role)
  if (choice && choice.provider !== 'auto') {
    if (providerReady(choice.provider)) {
      const model = choice.model?.trim() || defaultModel(choice.provider, role)
      if (model) return { role, provider: choice.provider, model, effort }
    }
    console.log(`[models] ${role}: ${choice.provider} is not available, using the default`)
  }
  const fallback = activeProvider()
  // A model picked for an unavailable provider never goes to another one (a local or service
  // id would 404 there); only an 'auto' choice or an id of the fallback's own family stays.
  const picked = choice?.model?.trim()
  const chosen =
    picked && (choice?.provider === 'auto' || providerOfModel(picked) === fallback)
      ? picked
      : undefined
  if (fallback === 'local' && !chosen) {
    // One local model for every role (loading a second one would evict the first).
    return { role, provider: 'local', model: localServer()!.model, effort }
  }
  const override = chosen || (fallback === 'local' ? undefined : overrideFor(role))
  if (override) {
    const owner = providerOfModel(override) ?? fallback
    if (providerReady(owner)) return { role, provider: owner, model: override, effort }
    console.log(`[models] ignoring ${role} override "${override}": no ${owner} key`)
  }
  return { role, provider: fallback, model: defaultModel(fallback, role), effort }
}

/** Display name for the UI, e.g. "Sonnet 5.5" for claude-sonnet-5-5. */
export function modelLabel(model: string): string {
  const claude = /^claude-(\w+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(model)
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1)
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  if (/^gpt-/i.test(model)) return model.replace(/^gpt-/i, 'GPT-')
  const gemini = /^gemini-([\d.]+)-(flash|pro)(-lite)?/i.exec(model)
  if (gemini)
    return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}${gemini[3] ? '-Lite' : ''}`
  // Local / hosted names like "qwen3.5:9b" or "lmstudio-community/gemma-4-12b": drop the publisher.
  return model.split('/').pop() ?? model
}
