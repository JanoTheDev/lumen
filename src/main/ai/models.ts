// Model registry: which provider + model + effort serves each role. One key is enough for
// every role; per-role overrides from config.models apply when their provider has a key.
import { loadConfig } from '../config'
import type { Effort, ProviderId } from './providers/types'

/**
 * fast: routing, verification, short answers. main: answers, guides, grounding.
 * planning: multi-step and agent runs. vision-refine: the zoom-crop second pass.
 */
export type Role = 'fast' | 'main' | 'planning' | 'vision-refine'

type CloudProvider = 'anthropic' | 'openai'

export const DEFAULT_MODELS: Record<CloudProvider, Record<Role, string>> = {
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
  }
}

const ROLE_EFFORT: Record<Role, Effort> = {
  fast: 'low',
  main: 'low',
  planning: 'low',
  'vision-refine': 'low'
}

/** Pinned for the per-click Computer Use call; the 5.5 models reject that tool version. */
export const COMPUTER_USE_MODEL = 'claude-sonnet-4-6'

export interface RoleModel {
  role: Role
  provider: ProviderId
  model: string
  effort: Effort
}

function hasKey(p: CloudProvider): boolean {
  return p === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY
}

/** The provider a model id belongs to, or null when it is not recognisable. */
export function providerOfModel(model: string): CloudProvider | null {
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^(gpt-|chatgpt-|o\d)/i.test(model)) return 'openai'
  return null
}

/** The provider that serves the defaults: the configured one when it has a key, else any key. */
export function activeProvider(): CloudProvider {
  const preferred = loadConfig().models.provider
  if ((preferred === 'anthropic' || preferred === 'openai') && hasKey(preferred)) return preferred
  if (hasKey('anthropic')) return 'anthropic'
  if (hasKey('openai')) return 'openai'
  throw new Error('No API key found. Add an Anthropic or OpenAI key in Settings.')
}

// Config keys checked per role, first non-empty wins. `verify` is the v1 name of the fast role.
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

export function resolveRole(role: Role): RoleModel {
  const fallback = activeProvider()
  const effort = ROLE_EFFORT[role]
  const override = overrideFor(role)
  if (override) {
    const owner = providerOfModel(override) ?? fallback
    if (hasKey(owner)) return { role, provider: owner, model: override, effort }
    console.log(`[models] ignoring ${role} override "${override}": no ${owner} key`)
  }
  return { role, provider: fallback, model: DEFAULT_MODELS[fallback][role], effort }
}

/** Display name for the UI, e.g. "Sonnet 5.5" for claude-sonnet-5-5. */
export function modelLabel(model: string): string {
  const claude = /^claude-(\w+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(model)
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1)
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  return model.replace(/^gpt-/i, 'GPT-')
}
