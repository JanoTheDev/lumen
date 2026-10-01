// One user turn: route it (LLM router, or the legacy regex steering behind config
// ai.router = "legacy"), gather screen context, call the model (directly, via the planner
// or the research loop) and present the result.
import { randomUUID } from 'crypto'
import type { ModelResponse } from '@shared/types'
import { isAbortError, type CancelScope } from './cancel'
import { needsScreenshot, takeSpeculative, windowOnlyContext, type QueryContext } from './context'
import { captureContext } from './capture'
import { applyOverrides, LOCATE_RE } from './legacy/overrides'
import { isResearchIntent } from './legacy/classifier'
import { runFollowUps, runPlanned, runResearch } from './research'
import { present, type GuideStartFn } from './present'
import { mergeSplit, recordSplitHistory, runParallelSplit, type SubResult } from './parallel'
import {
  describeRoute,
  isContinuation,
  mainModeFor,
  MIN_ROUTE_CONFIDENCE,
  routeWithLlm,
  type Route
} from './router'
import { callModel, type CallOptions } from '../ai'
import { addToHistory, historyExchange } from '../ai/history'
import { recordTurn } from '../ai/memory/runtime'
import { appNameOf } from '../ai/skills'
import { withTurnCost, type TurnCost } from '../ai/cost'
import { bus } from '../bus'
import { guideState } from '../guides/session'
import { requireAgent } from '../agent/instance'
import { loadConfig } from '../config'
import { log, startTimer } from '../logger'

export interface PipelineDeps {
  speak: (text: string, voice: string) => Promise<void>
  onGuide: GuideStartFn
}

/** How a turn runs, decided before the main call. */
interface TurnPlan {
  /** Prompt sent to the model (the legacy path appends steering text). */
  prompt: string
  path: 'model' | 'plan' | 'research' | 'split'
  /** Independent answer questions run in parallel (path "split"). */
  subqueries?: string[]
  /** Model-call options from the route (routedMode, targetApp). */
  routing: Pick<CallOptions, 'routedMode' | 'targetApp'>
  /** A locate request: a navigate + follow_up reply must end in locate. */
  locate: boolean
}

// LLM path: the previous routed task, for "do it" continuations, and the last reply mode.
let lastTask: { prompt: string; route: Route } | null = null
let lastMode: string | undefined
// Legacy path: effective prompt of the previous full turn.
let legacyTaskContext: string | null = null

/** Whether "do it" has a previous task to confirm. */
export function hasLastTask(): boolean {
  return loadConfig().ai.router === 'legacy' ? !!legacyTaskContext : !!lastTask
}

/** Awaits a pending capture, capturing again if it failed. */
async function screenContext(
  pending: Promise<QueryContext> | null,
  signal?: AbortSignal
): Promise<QueryContext> {
  const ctx = pending ? await pending.catch(() => null) : null
  if (ctx) {
    log('plan', 'using speculative screenshot')
    return ctx
  }
  return captureContext(true, { signal })
}

/**
 * Runs one turn and publishes `query.done` with the model and the turn's summed cost, or
 * `query.cancelled` / `query.failed`.
 */
export async function runQuery(
  prompt: string,
  baseOpts: CallOptions,
  scope: CancelScope,
  deps: PipelineDeps
): Promise<ModelResponse> {
  let cost: TurnCost | undefined
  const turnId = randomUUID()
  bus.emit({ type: 'query.started', turnId, prompt })
  let response: ModelResponse
  try {
    response = await withTurnCost(
      () => runTurn(prompt, { ...baseOpts, turnId }, scope, deps),
      (c) => (cost = c)
    )
  } catch (e) {
    if (scope.cancelled || isAbortError(e)) {
      log('skip', `turn cancelled: "${prompt.slice(0, 40)}"`)
      bus.emit({ type: 'query.cancelled', turnId })
    } else {
      bus.emit({ type: 'query.failed', turnId, error: (e as Error).message })
    }
    throw e
  }
  bus.emit({
    type: 'query.done',
    turnId,
    response,
    model: cost?.model,
    cost: cost && { usd: cost.usd, calls: cost.calls, ...cost.usage }
  })
  return response
}

/** Legacy steering: regex classifier + prompt overrides, screenshot by keyword heuristic. */
async function planLegacy(
  prompt: string,
  opts: CallOptions
): Promise<{ plan: TurnPlan; ctx: QueryContext }> {
  const needsShot = needsScreenshot(prompt)
  log('plan', `needs screenshot: ${needsShot}`)
  const ctx = needsShot
    ? await screenContext(takeSpeculative(), opts.signal)
    : await captureContext(false, { signal: opts.signal })

  const { effectivePrompt, flags, intent, requestedApp, nextTaskContext } = applyOverrides({
    prompt,
    activeWindow: ctx.activeWindow,
    lowDetail: opts.lowDetail,
    lastTaskContext: legacyTaskContext
  })
  if (flags.length) log('plan', `overrides: ${flags.join(', ')}`)
  if (requestedApp) log('plan', `app-switch detected: ${requestedApp.app} → ${requestedApp.url}`)
  if (intent.isContinuation && legacyTaskContext)
    log('plan', `continuation detected, re-running: "${legacyTaskContext}"`)
  legacyTaskContext = nextTaskContext

  const research = !opts.lowDetail && isResearchIntent(prompt)
  const planned = !opts.lowDetail && intent.planRequired
  return {
    ctx,
    plan: {
      prompt: research ? prompt : effectivePrompt,
      path: research ? 'research' : planned ? 'plan' : 'model',
      routing: {},
      locate: !opts.lowDetail && intent.mode === 'locate' && LOCATE_RE.test(prompt)
    }
  }
}

/**
 * LLM steering: the router runs on the fast model while the screen is captured. The capture
 * starts before the route is known (hotkey-up already started one for voice); when the
 * route needs no screen the capture is simply dropped.
 */
async function planRouted(
  prompt: string,
  opts: CallOptions,
  scope: CancelScope
): Promise<{ plan: TurnPlan; ctx: QueryContext }> {
  const agent = requireAgent()
  let utterance = prompt
  let forced: Route | null = null
  if (!opts.lowDetail && lastTask && isContinuation(prompt)) {
    utterance = lastTask.prompt
    const mode = lastTask.route.mode === 'plan' ? 'plan' : 'action'
    forced = { ...lastTask.route, mode, needsScreen: true, confidence: 1 }
    log('plan', `continuation: re-running "${utterance.slice(0, 60)}" as ${mode}`)
  }

  // Follow-up steps (lowDetail) always need the screen and are not routed: the reply mode
  // follows from the follow-up instruction.
  let pending = takeSpeculative()
  if (!pending && (opts.lowDetail || forced || needsScreenshot(utterance))) {
    pending = captureContext(true, { signal: scope.signal })
    pending.catch(() => {})
  }

  let route: Route | null = forced
  let activeWindow: string | null = null
  if (!route && !opts.lowDetail) {
    activeWindow = await agent.activeWindow()
    route = await routeWithLlm(
      { utterance, activeWindow, guideActive: guideState().guideActive, lastMode },
      scope.signal
    )
  }
  scope.throwIfCancelled()
  if (route) log('plan', `route: ${describeRoute(route)}`)

  const needsScreen = route ? route.needsScreen : true
  const ctx =
    needsScreen || activeWindow === null
      ? await screenContext(pending, scope.signal)
      : windowOnlyContext(activeWindow)
  if (!opts.lowDetail && route) lastTask = { prompt: utterance, route }

  const routedMode = mainModeFor(route) ?? undefined
  const targetApp = route?.appSwitch && route.targetApp ? route.targetApp : undefined
  const confident = !!route && route.confidence >= MIN_ROUTE_CONFIDENCE
  return {
    ctx,
    plan: {
      prompt: utterance,
      path: !confident
        ? 'model'
        : route?.parallelSplit
          ? 'split'
          : route?.mode === 'research'
            ? 'research'
            : route?.mode === 'plan'
              ? 'plan'
              : 'model',
      subqueries: route?.parallelSplit,
      routing: { routedMode, targetApp },
      locate: route?.mode === 'locate'
    }
  }
}

async function runTurn(
  prompt: string,
  baseOpts: CallOptions,
  scope: CancelScope,
  deps: PipelineDeps
): Promise<ModelResponse> {
  requireAgent()
  const opts: CallOptions = { ...baseOpts, signal: scope.signal }
  const timer = startTimer(`query "${prompt.slice(0, 60)}"${opts.lowDetail ? ' [low-detail]' : ''}`)
  const legacy = loadConfig().ai.router === 'legacy'
  log(
    'plan',
    `prompt: "${prompt}"${opts.lowDetail ? ' [low-detail]' : ''}${legacy ? ' [legacy router]' : ''}`
  )

  const { plan, ctx } = legacy
    ? await planLegacy(prompt, opts)
    : await planRouted(prompt, opts, scope)
  const { activeWindow, screenshot } = ctx
  scope.throwIfCancelled()
  timer.split('routed + context gathered')
  log('plan', `active window: ${activeWindow}`)
  log('plan', `query: "${plan.prompt.slice(0, 80)}"`)

  let result: ModelResponse
  let split: SubResult[] | null = null
  if (plan.path === 'split' && plan.subqueries) {
    log('plan', `parallel split: ${plan.subqueries.map((q) => `"${q.slice(0, 30)}"`).join(', ')}`)
    // No turnId: sub-answers do not stream speech; the merged answer is spoken once.
    split = await runParallelSplit(plan.subqueries, scope, (q, child) =>
      callModel(q, screenshot, activeWindow, {
        ...opts,
        context: ctx,
        turnId: undefined,
        signal: child.signal,
        routedMode: 'answer'
      })
    )
    result = mergeSplit(split)
    timer.split(`parallel split (${split.length}) done`)
  } else if (plan.path === 'research') {
    result = await runResearch(plan.prompt, ctx, opts, scope)
    timer.split('research agent done')
  } else if (plan.path === 'plan') {
    result = await runPlanned(plan.prompt, ctx, opts, scope, timer)
  } else {
    const callOpts = { ...opts, ...plan.routing, context: ctx }
    result = await callModel(plan.prompt, screenshot, activeWindow, callOpts)
    timer.split('callModel done')
  }

  log('done', `mode: ${result.mode}`)
  timer.total()
  // Nothing from a cancelled turn may reach the screen, TTS or history.
  scope.throwIfCancelled()
  if (!opts.lowDetail) lastMode = result.mode

  // Locate request answered with navigate + follow_up: make the follow-up step a locate so
  // highlights appear once the page has loaded.
  if (!opts.lowDetail && plan.locate && result.mode === 'action' && result.follow_up) {
    result.follow_up.query = `The page is loaded. Highlight where the user can find: "${prompt}". Use locate mode: each item's rect tightly wraps only the matching visible rows or elements. Do not click, navigate or open anything.`
    log('plan', 'locate chain: follow-up replaced with a locate step')
  }

  // Navigate-then-act replies run their follow-ups here, on the shared loop.
  let shown: QueryContext | undefined = ctx.frames.length ? ctx : undefined
  if (!opts.lowDetail && result.mode === 'action' && result.follow_up && result.actions?.length) {
    const chain = await runFollowUps(result, prompt, ctx, opts, scope)
    result = chain.response
    shown = chain.ctx ?? shown
    timer.split('follow-up chain done')
  }

  // Start TTS synth early — parallel to renderer showing the answer card
  const spoken = result.mode === 'answer' ? (result.spoken ?? result.text)?.trim() : ''
  if (spoken) {
    const cfgNow = loadConfig()
    if (cfgNow.voice.tts === 'cloud') {
      deps
        .speak(spoken, cfgNow.voice.ttsVoice)
        .catch((e) => console.warn('[tts] early synth failed:', (e as Error).message))
    }
  }

  await present(result, prompt, deps.onGuide, shown, scope.signal)
  scope.throwIfCancelled()

  if (split) recordSplitHistory(split, historyExchange)
  else if (!opts.lowDetail) addToHistory(historyExchange(prompt, result))
  if (!opts.lowDetail) {
    const { spoken, mode, targets } = historyExchange(prompt, result)
    const app = ctx.skill?.name ?? appNameOf(ctx.foreground.process)
    recordTurn({ utterance: prompt, answer: spoken, mode, targets, app })
  }
  return result
}
