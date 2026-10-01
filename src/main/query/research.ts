// Multi-step paths, all on the shared observe → act → verify loop (ai/loop.ts): a plan with
// verified steps, the research loop, and follow-up chains (navigate, then act on the loaded
// page). Each supplies its own decide step; observation, execution, settle waits,
// verification, idempotent retries and the risky-step confirm are shared.
import type { Action, ModelResponse } from '@shared/types'
import type { CancelScope } from './cancel'
import type { QueryContext } from './context'
import { normText } from './resolve-target'
import { callModel, type CallOptions } from '../ai'
import { buildPlan, replan, stepPrompt } from '../ai/planner'
import {
  runLoop,
  type Decision,
  type LoopDeps,
  type LoopResult,
  type LoopStep,
  type StepState
} from '../ai/loop'
import { observationOf, observe, waitForSettle, type Observed } from '../ai/observe'
import { verify } from '../ai/verify'
import { executeActions } from '../actions/executor'
import { loadConfig } from '../config'
import { log, type Timer } from '../logger'
import { sleep } from '../util'
import { setStatus } from '../windows/status'

const DEFAULT_MAX_STEPS = 8
const DEFAULT_MAX_FOLLOW_UPS = 6
/** OCR matches shorter than this are too likely to be some other text on screen. */
const MIN_OCR_MATCH = 4

function limits(): { maxSteps: number; maxFollowUps: number } {
  const ai = loadConfig().ai
  return {
    maxSteps: ai.maxSteps ?? DEFAULT_MAX_STEPS,
    maxFollowUps: ai.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS
  }
}

/**
 * Whether `text` is already typed: the focused field's UIA value when the agent exposes it
 * (authoritative), else an OCR match of its start anywhere on screen.
 */
export async function alreadyTyped(text: string, now: Observed): Promise<boolean> {
  const want = normText(text)
  if (!want) return true
  const focus = now.obs.focus
  if (focus?.editable && focus.valueTail) return normText(focus.valueTail).includes(want.slice(-60))
  if (want.length < MIN_OCR_MATCH) return false
  const ocr = await now.ctx.ocr()
  if (!ocr) return false
  return normText(ocr.lines.map((l) => l.text).join(' ')).includes(want.slice(0, 40))
}

/**
 * The confirm hook for risky steps until 08's confirm state exists: says what is about to
 * happen and leaves the cancel window open (Esc / "cancel"); agent.confirm "never" skips it.
 */
async function confirmRisky(
  step: LoopStep,
  decision: Decision,
  signal: AbortSignal
): Promise<boolean> {
  const cfg = loadConfig().agent
  if (cfg.confirm === 'never') return true
  const what = decision.response.mode === 'action' ? decision.response.summary : undefined
  setStatus(
    'acting',
    `About to: ${what ?? step.intent}. Say "cancel" to stop.`,
    undefined,
    cfg.cancelWindowMs + 600
  )
  await sleep(cfg.cancelWindowMs)
  return !signal.aborted
}

function loopDeps(decide: LoopDeps['decide'], extra: Partial<LoopDeps> = {}): LoopDeps {
  return {
    observe,
    decide,
    act: (actions, o) => executeActions(actions, { signal: o.signal, forceRefine: o.forceRefine }),
    settle: (before, signal) => waitForSettle(before, signal),
    verify: (req, before, after, signal) => verify(req, before, after, signal),
    confirm: confirmRisky,
    alreadyTyped: (text, now) => alreadyTyped(text, now),
    progress: ({ index, total, intent, status }) =>
      setStatus(status === 'failed' ? 'error' : 'step', intent, { index, total }),
    ...extra
  }
}

/** Turns a step reply into what the loop runs. Guides click their first target. */
function toDecision(r: ModelResponse): Decision {
  switch (r.mode) {
    case 'action':
      return { response: r, actions: r.actions ?? [], risky: r.risk === 'high' }
    case 'text_insert':
      return { response: r, actions: r.text ? [{ type: 'type', text: r.text }] : [] }
    case 'guide': {
      const first = r.steps?.find((s) => s.target || s.bbox)
      const click: Action | null = first?.target
        ? { type: 'click_target', target: first.target, description: first.label }
        : first?.bbox
          ? { type: 'click_bbox', bbox: first.bbox, description: first.label }
          : null
      return { response: r, actions: click ? [click] : [] }
    }
    default:
      return { response: r, actions: [] }
  }
}

function stepCall(prompt: string, s: StepState, opts: CallOptions): Promise<ModelResponse> {
  return callModel(prompt, s.ctx.screenshot, s.ctx.activeWindow, {
    ...opts,
    context: s.ctx,
    routedMode: undefined,
    targetApp: undefined
  })
}

const answer = (text: string): ModelResponse => ({ mode: 'answer', text })

/** The turn's capture as the first observation; none without a screenshot. */
function startOf(ctx: QueryContext): Observed | undefined {
  return ctx.frames.length ? { ctx, obs: observationOf(ctx, null) } : undefined
}

// Plan ---------------------------------------------------------------------------------------

/** Multi-step: plan intents, then run each step grounded on a fresh screen and verified. */
export async function runPlanned(
  prompt: string,
  ctx: QueryContext,
  opts: CallOptions,
  scope: CancelScope,
  timer: Timer
): Promise<ModelResponse> {
  const signal = scope.signal
  let plan = await buildPlan(
    prompt,
    { activeWindow: ctx.activeWindow, screenshot: ctx.screenshot },
    signal
  )
  timer.split('buildPlan done')
  const decide = (s: StepState): Promise<Decision> => {
    const retryNote = s.attempt
      ? `Retry ${s.attempt}: the last attempt did not work (${s.lastFailure ?? 'no visible change'}). Use a different target than before: a listed element id, a numbered mark, or another visible label.`
      : undefined
    const step = {
      intent: s.step.intent,
      successCriteria: s.step.successCriteria ?? '',
      risky: !!s.step.risky
    }
    return stepCall(stepPrompt(plan.goal, step, s.index, s.total, s.history, retryNote), s, {
      ...opts,
      lowDetail: false
    }).then(toDecision)
  }
  const run = await runLoop(
    {
      goal: plan.goal,
      steps: plan.steps,
      maxSteps: limits().maxSteps,
      verify: true,
      signal,
      start: startOf(ctx)
    },
    loopDeps(decide, {
      replan: async (failed, history, now, sig) => {
        const next = await replan(
          plan,
          history,
          {
            step: {
              intent: failed.step.intent,
              successCriteria: failed.step.successCriteria ?? '',
              risky: !!failed.step.risky
            },
            reason: failed.reason
          },
          { activeWindow: now.ctx.activeWindow, screenshot: now.ctx.screenshot },
          sig
        )
        if (next) plan = next
        return next?.steps ?? null
      }
    })
  )
  timer.split('plan steps done')
  return planResult(plan.goal, run)
}

function planResult(goal: string, run: LoopResult): ModelResponse {
  const done = run.history.filter((h) => h.ok).length
  log('done', `plan ${run.status}: ${done}/${run.history.length} steps ok`)
  // Always plain answer mode: the renderer would otherwise run the last step's actions again.
  if (run.final?.mode === 'answer' && run.final.text.trim()) return answer(run.final.text)
  switch (run.status) {
    case 'done':
      return answer(`Done: ${goal}`)
    case 'denied':
      return answer(`Stopped before "${run.history.at(-1)?.intent ?? goal}": not confirmed.`)
    case 'blocked':
      return answer(`Stopped: the safety policy blocked a step of "${goal}".`)
    default:
      return answer(`Stopped after ${done}/${run.history.length} steps: ${goal}`)
  }
}

// Research -----------------------------------------------------------------------------------

function researchPrompt(goal: string, iteration: number, max: number): string {
  const first =
    iteration === 1
      ? `\nITERATION 1 RULE: if the current screen is not the subject of the task (wrong site, wrong app, unrelated content), respond with action mode + open_url to a Google search for it. Brand names and proper nouns the user mentioned take the navigate path on iteration 1; they are almost never already on screen.`
      : ''
  return `RESEARCH TASK: "${goal}"

You are an autonomous research agent. Look at the current screen and decide:
1. The requested information is clearly visible and this page is the intended subject: answer mode with the extracted content as a clean markdown summary (items, key facts, the direct answer). Do not say "the page shows"; just give the info.
2. Not visible yet but you can make progress: action mode with ONE of
   - open_url to a Google search (if you have not searched yet): "https://www.google.com/search?q=<encoded>"
   - a click on the most relevant link (skip ads; prefer official sites, job boards, listing pages)
   - scroll with amount=1 (one page) to see the next screenful; never amount >= 3.
3. Stuck (404, login wall, irrelevant page): answer mode with the obstacle and any partial info.
Do not include followUp; the agent loops by itself. Prefer answering as soon as you have enough.
Iteration ${iteration} of ${max}. Be decisive.${first}`
}

/** Autonomous loop: navigate / click / scroll until the info is found or the budget ends. */
export async function runResearch(
  prompt: string,
  ctx: QueryContext,
  opts: CallOptions,
  scope: CancelScope
): Promise<ModelResponse> {
  const { maxSteps } = limits()
  const decide = async (s: StepState): Promise<Decision> => {
    const r = await stepCall(researchPrompt(prompt, s.index, maxSteps), s, opts)
    if (r.mode === 'answer' && r.text?.trim()) return { response: r, actions: [], done: true }
    if (r.mode === 'action' && r.actions?.length)
      return { response: r, actions: r.actions, next: { intent: prompt } }
    log('fail', `research step ${s.index} returned unusable mode: ${r.mode}`)
    return {
      response: answer(`I couldn't find a clear answer for "${prompt}".`),
      actions: [],
      done: true
    }
  }
  const run = await runLoop(
    {
      goal: prompt,
      steps: [{ intent: prompt }],
      maxSteps,
      verify: false,
      continueAtBottom: true,
      signal: scope.signal,
      start: startOf(ctx)
    },
    loopDeps(decide)
  )
  if (run.status === 'done' && run.final) return run.final
  log('fail', `research ended: ${run.status} after ${run.steps} steps`)
  return answer(`I couldn't find a clear answer for "${prompt}" within ${run.steps} steps.`)
}

// Follow-up chains ---------------------------------------------------------------------------

export interface ChainResult {
  response: ModelResponse
  /** Context the final reply was grounded on (present its targets against this one). */
  ctx?: QueryContext
}

/**
 * Runs an action reply that carries a follow_up: its actions, then each follow-up query on
 * the settled page, until a reply has no follow-up (max ai.maxFollowUps). Replaces the
 * renderer's chain and its fixed 2 s delay. The returned reply has nothing left to execute.
 */
export async function runFollowUps(
  first: Extract<ModelResponse, { mode: 'action' }>,
  prompt: string,
  ctx: QueryContext,
  opts: CallOptions,
  scope: CancelScope
): Promise<ChainResult> {
  let pending: ModelResponse | null = first
  const decide = async (s: StepState): Promise<Decision> => {
    let r: ModelResponse
    if (pending) {
      r = pending
      pending = null
    } else {
      const q = s.step.intent.startsWith('The page is loaded')
        ? s.step.intent
        : `The page is loaded. ${s.step.intent}`
      r = await stepCall(q, s, { ...opts, lowDetail: true, turnId: undefined })
    }
    if (r.mode === 'answer') {
      // An answer inside a chain means the model is done (or confused): stop silently.
      log('step', 'follow-up chain ended with an answer')
      return { response: r, actions: [], done: true }
    }
    const d = toDecision(r)
    if (r.mode === 'action' && r.follow_up) d.next = { intent: r.follow_up.query }
    return d
  }
  const { maxFollowUps } = limits()
  const run = await runLoop(
    {
      goal: prompt,
      steps: [{ intent: prompt }],
      maxSteps: 1 + maxFollowUps,
      verify: false,
      signal: scope.signal,
      start: startOf(ctx)
    },
    loopDeps(decide)
  )
  log('done', `follow-up chain ${run.status} after ${run.steps} steps`)
  const done: ModelResponse = { ...first, actions: [], follow_up: undefined }
  if (run.final?.mode === 'locate') return { response: run.final, ctx: run.last?.ctx }
  return { response: done, ctx: run.last?.ctx }
}
