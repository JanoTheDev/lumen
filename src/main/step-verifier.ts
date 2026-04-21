import crypto from 'crypto'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getModel, getProvider } from './model-router'
import { log } from './logger'

const VERIFY_ACTION_TYPES = new Set([
  'navigate_url', 'open_url', 'type', 'hotkey',
  'click_element', 'click_bbox', 'click'
])

export function shouldVerifyStep(actionType: string): boolean {
  return VERIFY_ACTION_TYPES.has(actionType)
}

export function hashScreenshot(base64: string): string {
  const buf = Buffer.from(base64, 'base64')
  const step = Math.max(1, Math.floor(buf.length / 100))
  const samples = Buffer.alloc(100)
  for (let i = 0; i < 100; i++) {
    samples[i] = buf[i * step] ?? 0
  }
  return crypto.createHash('md5').update(samples).digest('hex')
}

export interface VerifyResult {
  success: boolean
  detail: string
  cost: number
}

const PRICING_VERIFY = {
  anthropic: { input: 0.80, output: 4.00 },
  openai:    { input: 0.05, output: 0.40 },
}

export async function verifyStep(
  stepDescription: string,
  afterScreenshot: string,
  beforeHash: string
): Promise<VerifyResult> {
  const afterHash = hashScreenshot(afterScreenshot)
  if (afterHash === beforeHash) {
    log('verify', 'page unchanged — step likely failed')
    return { success: false, detail: 'page unchanged', cost: 0 }
  }

  const model = getModel('verification')
  const provider = getProvider()
  const start = Date.now()
  const prompt = `Step was: "${stepDescription}". Did it succeed? Reply only with JSON: {"success":true,"detail":"brief reason"}`

  let success = true
  let detail = 'page changed'
  let cost = 0

  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await client.messages.create({
        model,
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: afterScreenshot } },
            { type: 'text', text: prompt }
          ]
        }]
      })
      const raw = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
      const parsed = JSON.parse(raw) as { success?: boolean; detail?: string }
      success = parsed.success ?? true
      detail = parsed.detail ?? 'ok'
      const p = PRICING_VERIFY.anthropic
      cost = ((msg.usage.input_tokens / 1_000_000) * p.input) + ((msg.usage.output_tokens / 1_000_000) * p.output)
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      const resp = await client.chat.completions.create({
        model,
        max_completion_tokens: 64,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${afterScreenshot}`, detail: 'low' } },
            { type: 'text', text: prompt }
          ]
        }]
      })
      const raw = resp.choices[0]?.message?.content ?? '{}'
      const parsed = JSON.parse(raw) as { success?: boolean; detail?: string }
      success = parsed.success ?? true
      detail = parsed.detail ?? 'ok'
      const usage = resp.usage
      if (usage) {
        const p = PRICING_VERIFY.openai
        cost = ((usage.prompt_tokens / 1_000_000) * p.input) + ((usage.completion_tokens / 1_000_000) * p.output)
      }
    }
  } catch (e) {
    detail = `verify error: ${(e as Error).message}`
  }

  log('verify', detail, { model, cost, timeMs: Date.now() - start })
  return { success, detail, cost }
}
