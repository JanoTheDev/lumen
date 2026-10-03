// Google Gemini through its OpenAI-compatible endpoint (chat completions; the Responses API the
// openai provider uses is not offered there). Opt-in, for the free tier: key from AI Studio (env
// GEMINI_API_KEY or the vault), no card. Free-tier prompts and screenshots may be used to improve
// Google products and read by human reviewers (outside the EEA, UK and Switzerland); Settings
// says so before a key is saved. Verified against ai.google.dev, 2026-10-01 (plans/05 notes).
import type OpenAI from 'openai'
import { loadOpenAI } from './openai'
import { createChatBackend, type ChatBackend } from './chat-completions'
import { LlmError, type Effort } from './types'

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'
export const GEMINI_ENV = 'GEMINI_API_KEY'

/** Free-tier models (stable, text + image input), best first. */
export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
] as const

export const GEMINI_RATE_LIMIT_MESSAGE = 'Free tier limit reached, try again in a minute.'

/** Gemini maps `reasoning_effort` to its thinking level; `low` keeps replies quick. */
function geminiEffort(_model: string, effort: Effort = 'low'): OpenAI.ReasoningEffort {
  return effort
}

let client: { key: string; sdk: OpenAI } | null = null

async function sdk(): Promise<OpenAI> {
  const { default: OpenAI } = await loadOpenAI()
  const key = process.env[GEMINI_ENV]
  if (!key) throw new LlmError('E_NO_KEY', 'No Gemini key yet.')
  // One retry at most: on the free tier a retried 429 only burns more of the minute's quota.
  if (client?.key !== key)
    client = { key, sdk: new OpenAI({ apiKey: key, baseURL: GEMINI_BASE_URL, maxRetries: 1 }) }
  return client.sdk
}

export function createGeminiProvider(getClient: () => OpenAI | Promise<OpenAI> = sdk): ChatBackend {
  return createChatBackend({
    id: 'gemini',
    client: getClient,
    // Every Gemini chat model takes images and calls tools.
    vision: () => true,
    tools: () => true,
    params: { reasoningEffort: geminiEffort },
    rateLimitMessage: GEMINI_RATE_LIMIT_MESSAGE,
    warmup: async () => {
      try {
        await (await getClient()).models.list()
      } catch (e) {
        console.warn('[warmup] gemini:', (e as Error).message)
      }
    }
  })
}
