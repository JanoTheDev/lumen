// Model calls for the query pipeline. Provider is chosen by the router from the available keys.
import type { ModelResponse } from '@shared/types'
import { callAnthropic } from './providers/anthropic'
import { callOpenAI } from './providers/openai'
import { getProvider } from './router'
import { sanitizeResponse } from './schema'

export type { Action, Confidence, GuideStep as Step, ModelResponse as ClaudeResponse } from '@shared/types'

export interface CallOptions {
  lowDetail?: boolean  // use low-res image + fewer tokens (for follow_up row enumeration)
  signal?: AbortSignal
}

export async function callModel(
  prompt: string,
  screenshotBase64: string | null,
  activeWindow: string,
  opts: CallOptions = {}
): Promise<ModelResponse> {
  const call = getProvider() === 'anthropic' ? callAnthropic : callOpenAI
  return sanitizeResponse(await call(prompt, screenshotBase64, activeWindow, opts))
}

/** @deprecated Use callModel. */
export const callClaude = callModel
