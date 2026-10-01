// Model calls for the query pipeline. Provider and model come from the role router.
import type { ModelResponse } from '@shared/types'
import { bus } from '../bus'
import { currentFrame } from '../actions/coords'
import { historyMessages } from './history'
import { logPrefixSize, systemBlocks, userTurn } from './prompts/assemble'
import { parseReplyText, replySchema, toModelResponse } from './schema'
import { LlmError, REFUSAL_MESSAGE, getProvider, onUsage, warmupProviders } from './providers'
import { noteAnswerModel, recordUsage } from './cost'

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
  const { llm, model, effort } = getProvider('main')
  logPrefixSize()
  try {
    const res = await llm.complete(
      {
        model,
        system: systemBlocks(),
        messages: [
          ...historyMessages(),
          {
            role: 'user',
            content: userTurn({
              prompt,
              activeWindow,
              frame: screenshotBase64 ? { w: imgW, h: imgH } : null
            })
          }
        ],
        images: screenshotBase64
          ? [{ base64: screenshotBase64, detail: opts.lowDetail ? 'low' : 'high' }]
          : [],
        maxTokens: opts.lowDetail ? 2048 : 4096,
        effort,
        schema: replySchema,
        schemaName: 'lumen_reply'
      },
      opts.signal
    )
    noteAnswerModel(res.model)
    const reply = res.data?.response ?? parseReplyText(res.text)
    return toModelResponse(reply, activeWindow)
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
onUsage(recordUsage)
if (process.versions.electron) setImmediate(() => warmupProviders())
bus.on('voice.started', () => warmupProviders())
