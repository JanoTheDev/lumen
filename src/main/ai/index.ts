// Model calls for the query pipeline. Provider and model come from the role router.
import type { ModelResponse } from '@shared/types'
import { bus } from '../bus'
import { currentFrame } from '../actions/coords'
import { historyMessages } from './history'
import { buildSystemBlocks } from './prompts/system'
import { getModel, getProvider } from './router'
import { parseResponse, sanitizeResponse } from './schema'
import { LlmError, REFUSAL_MESSAGE, onUsage, providerFor, warmupProviders } from './providers'
import { logUsage } from './pricing'

export type {
  Action,
  Confidence,
  GuideStep as Step,
  ModelResponse as ClaudeResponse
} from '@shared/types'

export interface CallOptions {
  lowDetail?: boolean // use low-res image + fewer tokens (for follow_up row enumeration)
  signal?: AbortSignal
}

export async function callModel(
  prompt: string,
  screenshotBase64: string | null,
  activeWindow: string,
  opts: CallOptions = {}
): Promise<ModelResponse> {
  const { imgW, imgH } = currentFrame()
  try {
    const res = await providerFor(getProvider()).complete(
      {
        model: getModel('main'),
        system: buildSystemBlocks(activeWindow),
        messages: [
          ...historyMessages(),
          {
            role: 'user',
            content: `Active window: ${activeWindow}\nScreenshot dimensions: ${imgW}x${imgH} pixels (all coordinates must be within this range)\n\nUser request: ${prompt}`
          }
        ],
        images: screenshotBase64
          ? [{ base64: screenshotBase64, detail: opts.lowDetail ? 'low' : 'high' }]
          : [],
        maxTokens: opts.lowDetail ? 2048 : 4096,
        effort: 'low',
        json: true
      },
      opts.signal
    )
    return sanitizeResponse(parseResponse(res.text))
  } catch (e) {
    if (e instanceof LlmError && e.code === 'E_REFUSED')
      return { mode: 'answer', text: REFUSAL_MESSAGE }
    throw e
  }
}

/** @deprecated Use callModel. */
export const callClaude = callModel

// Warm the SDK connection pools at startup (after .env is loaded) and whenever the user starts
// speaking, so the request after the transcript skips the TLS handshake.
onUsage(logUsage)
if (process.versions.electron) setImmediate(() => warmupProviders())
bus.on('voice.started', () => warmupProviders())
