// Settings → Models & keys: names, links and picker options from models:catalog. Pure.
import type { CatalogProvider, KeyProvider, ModelRoleId, ModelsCatalog } from '@shared/channels'
import type { CompatiblePreset, ModelProvider } from '@shared/config'
import { COMPATIBLE_PRESET_INFO } from '@shared/model-providers'

export const PROVIDER_NAME: Record<KeyProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  compatible: 'OpenAI-compatible'
}

export function presetLabel(p: CompatiblePreset): string {
  return p === 'custom' ? 'Custom address' : COMPATIBLE_PRESET_INFO[p].label
}

/** Where to get a key for the chosen service, or null (custom address). */
export function keyLinkFor(
  provider: KeyProvider,
  preset: CompatiblePreset,
  links: Record<'anthropic' | 'openai' | 'gemini', string>
): string | null {
  if (provider !== 'compatible') return links[provider]
  return preset === 'custom' ? null : COMPATIBLE_PRESET_INFO[preset].keysUrl
}

export const ROLE_INFO: Record<ModelRoleId, { label: string; hint: string }> = {
  main: { label: 'Answers', hint: 'Answers questions and decides what to click.' },
  planning: { label: 'Planning', hint: 'Breaks bigger tasks into steps and runs them.' },
  fast: { label: 'Fast', hint: 'Routing, checking a step worked, short replies.' },
  vision: { label: 'Close look', hint: 'Zooms in on part of the screen to find small things.' }
}

export const ROLE_ORDER: ModelRoleId[] = ['main', 'planning', 'fast', 'vision']

export interface Option {
  value: string
  label: string
}

/** Providers a role can be set to: "Automatic", then each ready provider (and the current pick). */
export function providerOptions(c: ModelsCatalog, current: ModelProvider | 'auto'): Option[] {
  const out: Option[] = [{ value: 'auto', label: 'Automatic' }]
  for (const p of c.providers)
    if (p.ready || p.id === current)
      out.push({ value: p.id, label: p.ready ? p.label : `${p.label} (not set up)` })
  return out
}

/** One model line: label plus what it lacks / costs, e.g. "llama3.1:8b · no images · free". */
export function modelOptionLabel(p: CatalogProvider, m: CatalogProvider['models'][number]): string {
  const facts = [
    !m.vision && 'no images',
    !m.tools && 'no multi-step tasks',
    p.free ? 'free' : !m.priced && 'no price known'
  ].filter(Boolean)
  return facts.length ? `${m.label} · ${facts.join(' · ')}` : m.label
}

/** Models for a role's picker: "Default" first, the current custom id kept when not listed. */
export function modelOptions(p: CatalogProvider | undefined, current: string): Option[] {
  const out: Option[] = [{ value: '', label: 'Default' }]
  if (!p) return out
  for (const m of p.models) out.push({ value: m.id, label: modelOptionLabel(p, m) })
  if (current && !p.models.some((m) => m.id === current))
    out.push({ value: current, label: current })
  return out
}

/** "Gemini 3.8 Flash on Google Gemini (free tier)", or why nothing serves the role. */
export function roleLine(c: ModelsCatalog, role: ModelRoleId): string {
  const r = c.roles[role]
  if (!r) return c.localOnly ? 'Nothing yet: start Ollama or LM Studio.' : 'Nothing yet: add a key.'
  const p = c.providers.find((x) => x.id === r.provider)
  const m = p?.models.find((x) => x.id === r.model)
  return `Now: ${m?.label ?? r.model} (${p?.label ?? r.provider})`
}
