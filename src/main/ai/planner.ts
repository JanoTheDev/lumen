// Multi-step planner (T18). A plan holds intents, never coordinates: each step is grounded at
// execution time against a fresh screen context (loop.ts). The planning role returns
// structured output; replanning after a failed step keeps what is already done.
import { z } from 'zod'
import { getProvider } from './providers'
import { parseJsonAs } from './json'
import { UNTRUSTED_CONTENT_RULE } from './prompts/untrusted'
import { log } from '../logger'

export const planSchema = z.object({
  goal: z.string(),
  steps: z.array(
    z.object({
      intent: z.string(),
      successCriteria: z.string(),
      risky: z.boolean()
    })
  )
})

export type Plan = z.infer<typeof planSchema>
export type PlanStep = Plan['steps'][number]

/** What happened to one executed step (fed back into step prompts and replanning). */
export interface StepRecord {
  intent: string
  ok: boolean
  note?: string
}

export interface PlanContext {
  activeWindow: string
  /** Frame "1" of the current screen, sent at low detail; optional. */
  screenshot?: string | null
}

export const MAX_PLAN_STEPS = 6
// Steps that change something outside the screen: always flagged risky (confirm hook).
const RISKY_RE =
  /\b(send|submit|post|publish|delete|remove|pay|purchase|buy|order|transfer|sign out|uninstall|format)\b/i

const PLANNER_SYSTEM = `You are the task planner of a private desktop assistant that operates the user's own computer. Reply with a JSON plan only.

${UNTRUSTED_CONTENT_RULE}

A plan is {"goal": "<the user's goal, one line>", "steps": [{"intent": "...", "successCriteria": "...", "risky": false}]}.

Rules:
- Each step is ONE semantic action that the executor grounds on the live screen with 1-3 low-level actions. Write intents, never coordinates or pixel positions.
- No setup steps: focusing windows, clicking the address bar, pressing Enter, waiting for loads. The executor does those.
- Opening a page is ONE step: "Navigate to <full URL>".
- Filling a form is ONE step: "Fill Subject \\"...\\" and Body with ..." (never one step per field).
- successCriteria: what the screen shows once the step worked, checkable at a glance ("A compose window is open", "The Subject field contains \\"Resignation\\"", "The page title mentions weather").
- risky: true for any step that sends, submits, posts, publishes, deletes, pays or buys. Only include such a step when the user explicitly asked for it ("send it", "post it"); otherwise stop once the content is ready for the user to review.
- Never invent a recipient, account or value the user did not give.
- Research goals end with a step "Read the page and report <what was asked>".
- At most ${MAX_PLAN_STEPS} steps; prefer fewer. A single navigation is exactly one step.

Example, "email my boss I'm quitting":
{"goal":"Draft a resignation email","steps":[
 {"intent":"Navigate to https://mail.google.com","successCriteria":"The Gmail inbox is visible","risky":false},
 {"intent":"Click Compose","successCriteria":"A new message window is open","risky":false},
 {"intent":"Fill Subject \\"Resignation\\" and Body with a short resignation note (leave To empty)","successCriteria":"Subject and body are filled in","risky":false}]}`

function describeHistory(history: StepRecord[]): string {
  if (!history.length) return 'nothing yet'
  return history
    .map(
      (h, i) => `${i + 1}. ${h.intent} - ${h.ok ? 'done' : 'failed'}${h.note ? ` (${h.note})` : ''}`
    )
    .join('\n')
}

/** Trims, caps and flags a raw plan; never returns an empty plan. */
export function normalizePlan(raw: Plan | null, goal: string): Plan {
  const steps = (raw?.steps ?? [])
    .map((s) => ({
      intent: s.intent.trim(),
      successCriteria: s.successCriteria.trim(),
      risky: s.risky || RISKY_RE.test(s.intent)
    }))
    .filter((s) => s.intent)
    .slice(0, MAX_PLAN_STEPS)
  if (!steps.length) return singleStep(goal)
  return { goal: raw?.goal.trim() || goal, steps }
}

/** The fallback plan: the goal itself as one step. */
export function singleStep(goal: string): Plan {
  return { goal, steps: [{ intent: goal, successCriteria: '', risky: RISKY_RE.test(goal) }] }
}

async function requestPlan(
  content: string,
  ctx: PlanContext,
  signal?: AbortSignal
): Promise<Plan | null> {
  const { llm, model, effort } = getProvider('planning')
  const t0 = Date.now()
  const res = await llm.complete(
    {
      model,
      system: [{ text: PLANNER_SYSTEM, cacheable: true }],
      messages: [{ role: 'user', content }],
      images: ctx.screenshot ? [{ base64: ctx.screenshot, detail: 'low' }] : [],
      maxTokens: 1024,
      effort,
      schema: planSchema,
      schemaName: 'lumen_plan'
    },
    signal
  )
  const plan = res.data ?? parseJsonAs(res.text, planSchema)
  log('plan', `planner ${model}: ${plan ? `${plan.steps.length} steps` : 'unusable reply'}`, {
    timeMs: Date.now() - t0
  })
  return plan
}

/** Plans `goal`. A planner failure falls back to the goal as a single step; cancel throws. */
export async function buildPlan(
  goal: string,
  ctx: PlanContext,
  signal?: AbortSignal
): Promise<Plan> {
  try {
    const raw = await requestPlan(
      `<goal>${goal}</goal>\n<foreground>${ctx.activeWindow}</foreground>`,
      ctx,
      signal
    )
    const plan = normalizePlan(raw, goal)
    log('plan', `plan "${plan.goal}": ${plan.steps.map((s) => s.intent).join(' | ')}`)
    return plan
  } catch (e) {
    if (signal?.aborted) throw e
    log('fail', `planner failed (${(e as Error).message}), running the goal as one step`)
    return singleStep(goal)
  }
}

/**
 * New remaining steps after `failed` could not be completed, given what is already done.
 * Null when the planner has no other way (or failed): the run stops there.
 */
export async function replan(
  plan: Plan,
  history: StepRecord[],
  failed: { step: PlanStep; reason: string },
  ctx: PlanContext,
  signal?: AbortSignal
): Promise<Plan | null> {
  const content = `<goal>${plan.goal}</goal>
<foreground>${ctx.activeWindow}</foreground>
<done>
${describeHistory(history)}
</done>
<failed>${failed.step.intent} - ${failed.reason}</failed>
The failed step did not work after retries. Plan only the REMAINING steps toward the goal from the current screen, using a different approach for the failed part (another route, a menu instead of a button, a keyboard shortcut). Do not repeat steps that are done. If there is no other way, return an empty steps list.`
  try {
    const raw = await requestPlan(content, ctx, signal)
    if (!raw?.steps.length) return null
    const next = normalizePlan(raw, plan.goal)
    log('plan', `replanned: ${next.steps.map((s) => s.intent).join(' | ')}`)
    return { goal: plan.goal, steps: next.steps }
  } catch (e) {
    if (signal?.aborted) throw e
    log('fail', `replan failed: ${(e as Error).message}`)
    return null
  }
}

/**
 * The main-model prompt for one step: the original goal, the step, what success looks like
 * and every step so far (AM: step prompts lacked the original task).
 */
export function stepPrompt(
  goal: string,
  step: PlanStep,
  index: number,
  total: number,
  history: StepRecord[],
  retryNote?: string
): string {
  return `<goal>${goal}</goal>
<step n="${index}" of="${total}">${step.intent}</step>
${step.successCriteria ? `<success>${step.successCriteria}</success>\n` : ''}<done>
${describeHistory(history)}
</done>
Do only this step, on the current screen. Use action mode for UI work; answer mode only when the step asks to read or report something. Do not include followUp.${retryNote ? `\n${retryNote}` : ''}`
}
