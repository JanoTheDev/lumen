import OpenAI from 'openai'
import type { ModelResponse } from '@shared/types'
import { buildSystemPrompt } from '../prompts/system'
import { historyMessages } from '../history'
import { getModel, reasoningParams } from '../router'
import { logUsage } from '../pricing'
import { parseResponse } from '../schema'
import { currentFrame } from '../../actions/coords'
import type { CallOptions } from '../index'

let client: OpenAI | null = null
let clientKey: string | undefined

/** Shared SDK client so requests reuse one connection pool; rebuilt if the key changes. */
export function openaiClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key })
    clientKey = key
  }
  return client
}

export type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
}

export async function callOpenAI(
  prompt: string,
  screenshotBase64: string | null,
  activeWindow: string,
  opts: CallOptions = {}
): Promise<ModelResponse> {
  const model = getModel('main')
  const systemPrompt = buildSystemPrompt(activeWindow)

  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = []
  if (screenshotBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: opts.lowDetail ? 'low' : 'high' }
    })
  }
  const { imgW, imgH } = currentFrame()
  userContent.push({
    type: 'text',
    text: `Active window: ${activeWindow}\nScreenshot dimensions: ${imgW}x${imgH} pixels (all coordinates must be within this range)\n\nUser request: ${prompt}`
  })

  const history: OpenAI.Chat.ChatCompletionMessageParam[] = historyMessages()

  const baseTokens = opts.lowDetail ? 4096 : 8192
  const send = (maxTokens: number): Promise<OpenAI.Chat.ChatCompletion> =>
    openaiClient().chat.completions.create({
      model,
      max_completion_tokens: maxTokens,
      ...reasoningParams(model),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userContent }
      ]
    } as ChatParams, { signal: opts.signal })
  let completion = await send(baseTokens)
  if (completion.choices[0]?.finish_reason === 'length') {
    console.log('[fail] truncated response, retrying with a larger max_completion_tokens')
    completion = await send(baseTokens * 2)
  }
  const usage = completion.usage
  if (usage) logUsage(model, usage.prompt_tokens, usage.completion_tokens, !!screenshotBase64)
  const raw = completion.choices[0]?.message?.content ?? ''
  return parseResponse(raw)
}
