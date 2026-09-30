import crypto from 'crypto'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getProvider, type Provider } from './model-router'
import { log } from './logger'

// Intentionally excludes navigate_url/open_url: verifier mis-judges slow page loads
// as failures (e.g. "Gmail loading screen" → retry → opens Gmail 4x).
// Hash-diff in executePlan already confirms the navigation changed the screen.
const VERIFY_ACTION_TYPES = new Set([
  'type', 'hotkey',
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
    log('verify', 'page unchanged', { cost: 0, timeMs: 0 })
    return { success: false, detail: 'page unchanged', cost: 0 }
  }

  const provider = getProvider()
  const VERIFY_MODEL: Record<Provider, string> = {
    anthropic: 'claude-haiku-4-5-20251001',
    openai: 'gpt-5-nano',
  }
  const model = VERIFY_MODEL[provider]
  const start = Date.now()
  const prompt = `You verify if a screen action succeeded by looking at the resulting screenshot.
Action attempted: "${stepDescription}"
Rules:
- If the expected app/page/state is visible (even loading, partially rendered, or with cookie banners) → success: true
- If an obviously wrong page, error message, or blocked dialog is visible → success: false
- If you cannot tell → success: true (do not retry on uncertainty)
- NEVER refuse. NEVER say "I cannot verify". Always choose true or false.
Reply ONLY with JSON: {"success":true,"detail":"<one short sentence>"}`

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
        max_completion_tokens: 512,
        reasoning_effort: 'minimal',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${afterScreenshot}`, detail: 'low' } },
            { type: 'text', text: prompt }
          ]
        }]
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' })
      const rawVerify = resp.choices[0]?.message?.content
      if (!rawVerify) {
        log('verify', 'no response from model, assuming success', { model, cost: 0, timeMs: Date.now() - start })
        return { success: true, detail: 'no response, assuming success', cost: 0 }
      }
      const parsed = JSON.parse(rawVerify.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) as { success?: boolean; detail?: string }
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

  // Safety net: verifier sometimes returns refusal/uncertainty phrased as success=false.
  // Those are not real failures — coerce to success to prevent wasted retries.
  if (!success && /\b(cannot|can't|unable to|unsure|not sure|don't know|dont know)\b/i.test(detail)) {
    log('verify', `coercing uncertain verdict to success: "${detail}"`, { model, cost, timeMs: Date.now() - start })
    return { success: true, detail: `uncertain (coerced): ${detail}`, cost }
  }

  log('verify', detail, { model, cost, timeMs: Date.now() - start })
  return { success, detail, cost }
}
