// models:catalog: what Settings → Models & keys shows: each provider, whether it is usable, the
// models a role can pick (with vision / tool / price facts) and what every role resolves to now.
import type { CatalogModel, CatalogProvider, ModelRoleId, ModelsCatalog } from '@shared/channels'
import type { ModelProvider } from '@shared/config'
import {
  geminiAcked,
  isLocalOnly,
  modelLabel,
  providerReady,
  resolveRole,
  type Role
} from '../models'
import { loadConfig } from '../../config'
import { rateFor } from '../pricing'
import { compatibleSettings, listCompatibleModels } from './compatible'
import { GEMINI_ENV, GEMINI_MODELS } from './gemini'
import { capsOf, chatModels, localServer } from './local'
import { refreshLocalModels } from './index'

// Picker lists for the native providers: the defaults plus the bigger model, cheapest first.
const ANTHROPIC_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
const OPENAI_MODELS = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5']

const ROLES: Record<ModelRoleId, Role> = {
  main: 'main',
  fast: 'fast',
  planning: 'planning',
  vision: 'vision-refine'
}

function cloudModel(id: string, free = false): CatalogModel {
  return { id, label: modelLabel(id), vision: true, tools: true, priced: free || rateFor(id).known }
}

function notReady(p: ModelProvider): string | undefined {
  if (providerReady(p)) return undefined
  if (p !== 'local' && isLocalOnly()) return 'Off while Local only is on.'
  if (p === 'local') return 'No Ollama or LM Studio running.'
  if (p === 'gemini' && process.env[GEMINI_ENV] && !geminiAcked())
    return 'Read the free-tier note first.'
  if (p === 'compatible') {
    const s = compatibleSettings()
    if (!s?.baseUrl) return 'Pick a service first.'
    if (!s.model) return 'Pick a default model.'
  }
  return 'No key yet.'
}

export async function buildCatalog(refresh = false): Promise<ModelsCatalog> {
  // Settings asks on open: a fresh look for a local server even when a cloud key covers all.
  const server = await refreshLocalModels(refresh).catch(() => localServer())
  const compat = compatibleSettings()
  const geminiPaid = loadConfig().models.geminiPaid === true
  const remote = await listCompatibleModels(refresh)
  const providers: CatalogProvider[] = [
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      ready: providerReady('anthropic'),
      note: notReady('anthropic'),
      free: false,
      models: ANTHROPIC_MODELS.map((m) => cloudModel(m))
    },
    {
      id: 'openai',
      label: 'OpenAI (ChatGPT)',
      ready: providerReady('openai'),
      note: notReady('openai'),
      free: false,
      models: OPENAI_MODELS.map((m) => cloudModel(m))
    },
    {
      id: 'gemini',
      label: geminiPaid ? 'Google Gemini' : 'Google Gemini (free tier)',
      ready: providerReady('gemini'),
      note:
        notReady('gemini') ??
        (geminiPaid ? undefined : 'Free tier: limited requests per minute and per day.'),
      free: !geminiPaid,
      models: GEMINI_MODELS.map((m) => cloudModel(m, !geminiPaid))
    },
    {
      id: 'compatible',
      label: compat?.label ?? 'Other OpenAI-compatible',
      ready: providerReady('compatible'),
      note: notReady('compatible'),
      free: false,
      models: remote.map((m) => ({
        id: m.id,
        label: m.id,
        vision: m.vision,
        tools: m.tools,
        priced: rateFor(m.id).known
      }))
    },
    {
      id: 'local',
      label: server
        ? `On this PC (${server.kind === 'lmstudio' ? 'LM Studio' : server.kind === 'ollama' ? 'Ollama' : 'local server'})`
        : 'On this PC (Ollama, LM Studio)',
      ready: providerReady('local'),
      note: notReady('local'),
      free: true,
      models: server
        ? chatModels(server.models).map((m) => ({
            id: m,
            label: modelLabel(m),
            ...capsOf(server, m),
            priced: true
          }))
        : []
    }
  ]
  const roles = {} as ModelsCatalog['roles']
  for (const [key, role] of Object.entries(ROLES) as [ModelRoleId, Role][]) {
    try {
      const r = resolveRole(role)
      roles[key] = { provider: r.provider, model: r.model }
    } catch {
      roles[key] = null
    }
  }
  return {
    providers,
    local: server ? { kind: server.kind, baseUrl: server.baseUrl } : null,
    compatible: compat ? { preset: compat.preset, baseUrl: compat.baseUrl } : null,
    roles,
    localOnly: isLocalOnly()
  }
}
