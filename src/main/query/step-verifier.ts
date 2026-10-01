import crypto from 'crypto'
import { usageCost } from '../ai/pricing'
import { getProvider } from '../ai/providers'
import { log } from '../logger'

// Intentionally excludes navigate_url/open_url: verifier mis-judges slow page loads
// as failures (e.g. "Gmail loading screen" → retry → opens Gmail 4x).
// Hash-diff in executePlan already confirms the navigation changed the screen.
const VERIFY_ACTION_TYPES = new Set(['type', 'hotkey', 'click_element', 'click_bbox', 'click'])

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

  const { llm, model, effort } = getProvider('fast')
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
    const res = await llm.complete({
      model,
      system: [],
      messages: [{ role: 'user', content: prompt }],
      images: [{ base64: afterScreenshot, detail: 'low' }],
      maxTokens: 256,
      effort,
      json: true
    })
    cost = usageCost(res.model, res.usage).total
    const rawVerify = res.text.trim()
    if (!rawVerify) {
      log('verify', 'no response from model, assuming success', {
        model,
        cost,
        timeMs: Date.now() - start
      })
      return { success: true, detail: 'no response, assuming success', cost }
    }
    const parsed = JSON.parse(
      rawVerify
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim()
    ) as { success?: boolean; detail?: string }
    success = parsed.success ?? true
    detail = parsed.detail ?? 'ok'
  } catch (e) {
    detail = `verify error: ${(e as Error).message}`
  }

  // Safety net: verifier sometimes returns refusal/uncertainty phrased as success=false.
  // Those are not real failures — coerce to success to prevent wasted retries.
  if (
    !success &&
    /\b(cannot|can't|unable to|unsure|not sure|don't know|dont know)\b/i.test(detail)
  ) {
    log('verify', `coercing uncertain verdict to success: "${detail}"`, {
      model,
      cost,
      timeMs: Date.now() - start
    })
    return { success: true, detail: `uncertain (coerced): ${detail}`, cost }
  }

  log('verify', detail, { model, cost, timeMs: Date.now() - start })
  return { success, detail, cost }
}
