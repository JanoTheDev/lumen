import crypto from 'crypto'
import { getModel, getProvider, reasoningParams } from '../ai/router'
import { usageCost } from '../ai/pricing'
import { anthropicClient } from '../ai/providers/anthropic'
import { openaiClient, type ChatParams } from '../ai/providers/openai'
import { log } from '../logger'

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
  const model = getModel('verify')
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
      const msg = await anthropicClient().messages.create({
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
      cost = usageCost(model, msg.usage.input_tokens, msg.usage.output_tokens).total
    } else {
      const resp = await openaiClient().chat.completions.create({
        model,
        max_completion_tokens: 512,
        ...reasoningParams(model),
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${afterScreenshot}`, detail: 'low' } },
            { type: 'text', text: prompt }
          ]
        }]
      } as ChatParams)
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
        cost = usageCost(model, usage.prompt_tokens, usage.completion_tokens).total
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
