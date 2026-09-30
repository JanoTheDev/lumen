import Anthropic from '@anthropic-ai/sdk'
import type { ModelResponse } from '@shared/types'
import { buildSystemPrompt } from '../prompts/system'
import { historyMessages } from '../history'
import { getModel } from '../router'
import { logUsage } from '../pricing'
import { parseResponse } from '../schema'
import { currentFrame } from '../../actions/coords'
import type { CallOptions } from '../index'

let client: Anthropic | null = null
let clientKey: string | undefined

/** Shared SDK client so requests reuse one connection pool; rebuilt if the key changes. */
export function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key })
    clientKey = key
  }
  return client
}

export async function callAnthropic(
  prompt: string,
  screenshotBase64: string | null,
  activeWindow: string,
  opts: CallOptions = {}
): Promise<ModelResponse> {
  const model = getModel('main')
  const systemPrompt = buildSystemPrompt(activeWindow)

  const userContent: Anthropic.MessageParam['content'] = []
  if (screenshotBase64) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 }
    })
  }
  const { imgW, imgH } = currentFrame()
  userContent.push({
    type: 'text',
    text: `Active window: ${activeWindow}\nScreenshot dimensions: ${imgW}x${imgH} pixels (all coordinates must be within this range)\n\nUser request: ${prompt}`
  })

  const history: Anthropic.MessageParam[] = historyMessages()

  const send = (maxTokens: number): Promise<Anthropic.Message> =>
    anthropicClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [...history, { role: 'user', content: userContent }]
      },
      { signal: opts.signal }
    )
  const baseTokens = opts.lowDetail ? 2048 : 4096
  let message = await send(baseTokens)
  if (message.stop_reason === 'max_tokens') {
    // Truncated JSON is unusable; one retry with more room.
    console.log('[fail] truncated response, retrying with a larger max_tokens')
    message = await send(baseTokens * 2)
  }
  logUsage(model, message.usage.input_tokens, message.usage.output_tokens, !!screenshotBase64)
  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  return parseResponse(raw)
}
