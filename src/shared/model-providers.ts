// Facts about the AI services Lumen can use, shared by main (requests) and Settings (pickers,
// links, the Gemini privacy note). Base URLs checked against each service's docs, 2026-10-01.
import type { CompatiblePreset } from './config'

export interface PresetInfo {
  label: string
  /** OpenAI-compatible base URL (the SDK appends /chat/completions, /models). */
  baseUrl: string
  /** Where to get a key. */
  keysUrl: string
}

export const COMPATIBLE_PRESET_INFO: Record<Exclude<CompatiblePreset, 'custom'>, PresetInfo> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/settings/keys'
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keysUrl: 'https://console.groq.com/keys'
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keysUrl: 'https://console.mistral.ai/api-keys'
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys'
  },
  together: {
    label: 'Together',
    baseUrl: 'https://api.together.ai/v1',
    keysUrl: 'https://api.together.ai/settings/api-keys'
  }
}

export const GEMINI_KEYS_URL = 'https://aistudio.google.com/apikey'

/** Shown before a Gemini key can be saved (ai.google.dev/gemini-api/terms, 2026-04-28). */
export const GEMINI_FREE_TIER_NOTE =
  'On the free tier, Google may use what Lumen sends (your questions and screenshots of your ' +
  'screen) to improve its products, and human reviewers may read it. In the EEA, the UK and ' +
  'Switzerland this does not apply. Don’t use it for anything private or confidential. You must ' +
  'be 18 or older. Free use is limited to a number of requests per minute and per day.'
