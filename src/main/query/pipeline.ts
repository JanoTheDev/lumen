// One user turn: route it (LLM router, or the legacy regex steering behind config
// ai.router = "legacy"), gather screen context, call the model (directly, or as an agent-mode
// task for multi-step and research requests) and present the result.
import { randomUUID } from 'crypto'
import type { ModelResponse } from '@shared/types'
import { isAbortError, type CancelScope } from './cancel'
import { needsScreenshot, takeSpeculative, windowOnlyContext, type QueryContext } from './context'
import { captureContext } from './capture'
import { applyOverrides, LOCATE_RE } from './legacy/overrides'
import { isResearchIntent } from './legacy/classifier'
import { present, type GuideStartFn } from './present'
import { agentModeAvailable, withNoAgentNote } from './agent-fallback'
import { mergeSplit, recordSplitHistory, runParallelSplit, type SubResult } from './parallel'
import {
  describeRoute,
  isContinuation,
  mainModeFor,
  matchBackgroundIntent,
  mentionsOtherScreen,
  MIN_ROUTE_CONFIDENCE,
  routeWithLlm,
  type Route
} from './router'
import { callModel, newFileClaim, type CallOptions } from '../ai'
import { addToHistory, historyExchange } from '../ai/history'
import { recordTurn } from '../ai/memory/runtime'
import { appNameOf } from '../ai/skills'
import { withTurnCost, type TurnCost } from '../ai/cost'
import { setUsageFeature, withUsageFeature, withUsageScope } from '../usage/scope'
import { refreshLocalModels } from '../ai/providers'
import { bus } from '../bus'
import { guideState } from '../guides/session'
import { requireAgent } from '../agent/instance'
import { executeActions } from '../actions/executor'
import {
  hasPausedTask,
  isResumeRequest,
  resumeAgentTask,
  runAgentTask
} from '../agent-mode/session'
import { startBackgroundTask } from '../agent-mode/background'
import { enabledSkill } from '../agent-mode/skill-tools'
import { matchTrigger } from '../skills'
import { loadConfig } from '../config'
import { webTurn } from '../web'
import { cardsTurn } from '../cards/ask'
import { buddyTurn } from '../buddies/calling'
import { log, startTimer } from '../logger'

export interface PipelineDeps {
  speak: (text: string, voice: string) => Promise<void>
  onGuide: GuideStartFn
}

/** How a turn runs, decided before the main call. */
interface TurnPlan {
  /** Prompt sent to the model (the legacy path appends steering text). */
  prompt: string
  /** agent: multi-step and research requests run as an agent-mode task. */
  path: 'model' | 'agent' | 'split'
  /** Independent answer questions run in parallel (path "split"). */
  subqueries?: string[]
  /** Model-call options from the route (routedMode, targetApp). */
  routing: Pick<CallOptions, 'routedMode' | 'targetApp'>
  /** A locate request: a navigate + follow_up reply must end in locate. */
  locate: boolean
  /** The router picked an installed skill. */
  skill?: SkillCall
}

type SkillCall = { name: string; args?: { name: string; value: string }[] }

/**
 * "Show me how" (07 T18): a routed guide request becomes a lesson. The handler returns the
 * reply when a lesson started, or null to fall back to the old guide reply.
 */
export type TeachHandler = (
  prompt: string,
  ctx: QueryContext,
  signal: AbortSignal
) => Promise<ModelResponse | null>

let teachHandler: TeachHandler | null = null

export function setTeachHandler(fn: TeachHandler | null): void {
  teachHandler = fn
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
    // Keyless installs: make sure a local server found since the last check is used.
    if (process.versions.electron) await refreshLocalModels().catch(() => null)
    response = await withUsageScope({ origin: 'user-direct', feature: 'answer' }, () =>
      withTurnCost(
        () => runTurn(prompt, { ...baseOpts, turnId }, scope, deps),
        (c) => (cost = c)
      )
    )
  } catch (e) {
    if (scope.cancelled || isAbortError(e)) {
      log('skip', `turn cancelled (${prompt.length} chars)`)
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
    log(
      'plan',
      `continuation detected, re-running the last task (${legacyTaskContext.length} chars)`
    )
  legacyTaskContext = nextTaskContext

  const research = !opts.lowDetail && isResearchIntent(prompt)
  const planned = !opts.lowDetail && intent.planRequired
  return {
    ctx,
    plan: {
      prompt: research || planned ? prompt : effectivePrompt,
      path: research || planned ? 'agent' : 'model',
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
    log(
      'plan',
      `continuation: re-running the last utterance (${utterance.length} chars) as ${mode}`
    )
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
    const win = await agent.activeWindow()
    activeWindow = win
    route = await withUsageFeature('router', () =>
      routeWithLlm(
        { utterance, activeWindow: win, guideActive: guideState().guideActive, lastMode },
        scope.signal
      )
    )
  }
  if (route) setUsageFeature(route.mode)
  scope.throwIfCancelled()
  if (route) log('plan', `route: ${describeRoute(route)}`)

  const needsScreen = route ? route.needsScreen : true
  // Another monitor named: capture every monitor (the speculative capture has only the
  // foreground one).
  const allScreens = route ? !!route.needsAllScreens : mentionsOtherScreen(utterance)
  if (allScreens) log('plan', 'capturing every monitor')
  const ctx = allScreens
    ? await captureContext(true, { allScreens: true, signal: scope.signal })
    : needsScreen || activeWindow === null
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
          : route?.mode === 'research' || route?.mode === 'plan'
            ? 'agent'
            : 'model',
      subqueries: route?.parallelSplit,
      routing: { routedMode, targetApp },
      locate: route?.mode === 'locate',
      ...(confident && route?.skill ? { skill: route.skill } : {})
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
  if (!opts.lowDetail && isResumeRequest(prompt) && hasPausedTask()) {
    const resumed = resumeAgentTask(scope.signal)
    if (resumed) {
      const result = await resumed
      scope.throwIfCancelled()
      await present(result, prompt, deps.onGuide, undefined, scope.signal)
      return result
    }
  }
  // Buddies (08 T51/T52): making or editing one by voice, then calling one by name ("Inbox
  // Buddy, what's new?", "ask Price Buddy to …", "stop Price Buddy"). Only words that start with
  // or clearly address a buddy, so the rest of the turn is routed as usual.
  const buddy = opts.lowDetail ? null : await buddyTurn(prompt, scope.signal)
  if (buddy) {
    scope.throwIfCancelled()
    speakEarly(buddy, deps)
    await present(buddy, prompt, deps.onGuide, undefined, scope.signal)
    lastMode = buddy.mode
    addToHistory(historyExchange(prompt, buddy))
    return buddy
  }
  // Answer cards (05 T40): "the second one", "open the cheapest", "compare them", "cheaper ones".
  const cards = opts.lowDetail ? null : await cardsTurn(prompt, scope.signal)
  if (cards) {
    scope.throwIfCancelled()
    const result: ModelResponse =
      'response' in cards
        ? cards.response
        : agentModeAvailable()
          ? await runAgentTask(
              cards.research,
              await captureContext(false, { signal: scope.signal }),
              scope.signal,
              // The goal quotes card text from web pages: only the user's words go to the policy.
              { userText: cards.userText, observedText: cards.observedText }
            )
          : { mode: 'answer', text: 'Looking that up needs a model that can use tools.' }
    scope.throwIfCancelled()
    speakEarly(result, deps)
    await present(result, prompt, deps.onGuide, undefined, scope.signal)
    lastMode = result.mode
    addToHistory(historyExchange(prompt, result))
    return result
  }
  // Read the web with me (05 Phase W): "summarize this page", "top news", "open the second one".
  const web = opts.lowDetail ? null : await webTurn(prompt, scope.signal)
  if (web) {
    scope.throwIfCancelled()
    speakEarly(web, deps)
    await present(web, prompt, deps.onGuide, undefined, scope.signal)
    scope.throwIfCancelled()
    lastMode = web.mode
    addToHistory(historyExchange(prompt, web))
    return web
  }
  const bg = opts.lowDetail ? null : matchBackgroundIntent(prompt)
  // A skill's trigger phrase (11 T03/T04): runs as an agent task with the skill loaded, or as a
  // background task for `context: background` skills and "in the background, <phrase>".
  const hit = opts.lowDetail ? null : matchTrigger(bg?.prompt ?? prompt)
  const skill = hit?.kind === 'skill' ? enabledSkill(hit.name) : null
  if (bg && !skill) {
    const result = startInBackground(bg.prompt)
    await present(result, prompt, deps.onGuide, undefined, scope.signal)
    return result
  }
  if (skill) {
    log('plan', `skill trigger: ${skill.manifest.name}`)
    return runSkillTurn(
      bg?.prompt ?? prompt,
      { name: skill.manifest.name },
      !!bg,
      null,
      scope,
      deps
    )
  }
  const timer = startTimer(`query (${prompt.length} chars)${opts.lowDetail ? ' [low-detail]' : ''}`)
  const legacy = loadConfig().ai.router === 'legacy'
  log(
    'plan',
    `prompt: ${prompt.length} chars${opts.lowDetail ? ' [low-detail]' : ''}${legacy ? ' [legacy router]' : ''}`
  )

  const { plan, ctx } = legacy
    ? await planLegacy(prompt, opts)
    : await planRouted(prompt, opts, scope)
  const { activeWindow, screenshot } = ctx
  scope.throwIfCancelled()
  timer.split('routed + context gathered')
  log('plan', `active window: ${activeWindow}`)
  log('plan', `query: ${plan.prompt.length} chars`)

  // The router picked an installed skill (05): same path as a trigger phrase.
  if (plan.skill && enabledSkill(plan.skill.name)) {
    timer.total()
    return runSkillTurn(plan.prompt, plan.skill, false, ctx, scope, deps)
  }

  if (
    teachHandler &&
    !opts.lowDetail &&
    plan.path === 'model' &&
    plan.routing.routedMode === 'guide'
  ) {
    const taught = await teachHandler(plan.prompt, ctx, scope.signal).catch((e) => {
      if (scope.cancelled || isAbortError(e)) throw e
      log('fail', `show me how failed (${(e as Error).message}); falling back to a guide`)
      return null
    })
    scope.throwIfCancelled()
    if (taught) {
      timer.total()
      lastMode = 'guide'
      addToHistory(historyExchange(prompt, taught))
      return taught
    }
  }

  let result: ModelResponse
  let split: SubResult[] | null = null
  if (plan.path === 'split' && plan.subqueries) {
    log(
      'plan',
      `parallel split: ${plan.subqueries.length} parts (${plan.subqueries.map((q) => q.length).join(', ')} chars)`
    )
    // No turnId: sub-answers do not stream speech; the merged answer is spoken once. Dropped
    // files go with the first part about them only.
    const fileClaim = newFileClaim()
    split = await runParallelSplit(plan.subqueries, scope, (q, child) =>
      callModel(q, screenshot, activeWindow, {
        ...opts,
        context: ctx,
        turnId: undefined,
        signal: child.signal,
        routedMode: 'answer',
        fileClaim
      })
    )
    result = mergeSplit(split)
    timer.split(`parallel split (${split.length}) done`)
  } else if (plan.path === 'agent' && agentModeAvailable()) {
    result = await runAgentTask(plan.prompt, ctx, scope.signal)
    timer.split('agent task done')
  } else if (plan.path === 'agent') {
    log('plan', 'agent path needs tool use; the local model answers in one call')
    const callOpts = { ...opts, ...plan.routing, context: ctx }
    result = withNoAgentNote(await callModel(plan.prompt, screenshot, activeWindow, callOpts))
    timer.split('callModel done (no agent mode)')
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

  // Navigate-then-act replies: the first actions run here, then a locate step highlights on
  // the loaded page, or the rest continues as an agent task (no fixed delays either way).
  let shown: QueryContext | undefined = ctx.frames.length ? ctx : undefined
  if (!opts.lowDetail && result.mode === 'action' && result.follow_up && result.actions?.length) {
    const chain = await continueAfter(result, prompt, opts, scope)
    result = chain.response
    shown = chain.ctx ?? shown
    timer.split('follow-up done')
  }

  speakEarly(result, deps)

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

/** Starts cloud TTS synth early, in parallel with the renderer showing the answer card. */
function speakEarly(result: ModelResponse, deps: PipelineDeps): void {
  const spoken = result.mode === 'answer' ? (result.spoken ?? result.text)?.trim() : ''
  if (!spoken) return
  const cfgNow = loadConfig()
  if (cfgNow.voice.tts === 'cloud') {
    deps
      .speak(spoken, cfgNow.voice.ttsVoice)
      .catch((e) => console.warn('[tts] early synth failed:', (e as Error).message))
  }
}

/**
 * A skill run (11 T04 minimum): an agent task with the skill's instructions preloaded, or a
 * background task when the skill says `context: background` or the user said "in the background".
 */
async function runSkillTurn(
  prompt: string,
  call: SkillCall,
  background: boolean,
  ctx: QueryContext | null,
  scope: CancelScope,
  deps: PipelineDeps
): Promise<ModelResponse> {
  const skill = enabledSkill(call.name)!
  const args = call.args?.length
    ? ` (skill values: ${call.args.map((a) => `${a.name}=${a.value}`).join(', ')})`
    : ''
  let result: ModelResponse
  if (background || skill.manifest.context === 'background') {
    result = startInBackground(`${prompt}${args}`, skill.manifest.name)
  } else {
    const now =
      ctx ??
      windowOnlyContext(
        await requireAgent()
          .activeWindow()
          .catch(() => '')
      )
    result = await runAgentTask(prompt, now, scope.signal, {
      skill: skill.manifest.name,
      ...(call.args?.length ? { skillArgs: call.args } : {})
    })
    scope.throwIfCancelled()
  }
  await present(result, prompt, deps.onGuide, undefined, scope.signal)
  addToHistory(historyExchange(prompt, result))
  return result
}

/** "in the background, …" (08 T31): starts a background task; the reply says so. */
function startInBackground(prompt: string, skill?: string): ModelResponse {
  const t = startBackgroundTask({ prompt, origin: 'voice', ...(skill ? { skill } : {}) })
  const text =
    t.phase === 'queued'
      ? `Queued in the background: ${t.title}. It starts when another task finishes.`
      : `Working on it in the background: ${t.title}. I'll tell you when it's done.`
  return { mode: 'answer', text, spoken: text }
}

/**
 * Runs an action reply that needs the result on screen (follow_up): its actions, then either one
 * locate call on the loaded page or the remaining work as an agent task (skipping its plan and
 * countdown: the user already saw the request start). The reply has nothing left to execute.
 */
async function continueAfter(
  first: Extract<ModelResponse, { mode: 'action' }>,
  prompt: string,
  opts: CallOptions,
  scope: CancelScope
): Promise<{ response: ModelResponse; ctx?: QueryContext }> {
  const done: ModelResponse = { ...first, actions: [], follow_up: undefined }
  const ran = await executeActions(first.actions, { signal: scope.signal, userText: prompt })
  scope.throwIfCancelled()
  if (ran.denied || !ran.executed) return { response: done }
  const next = first.follow_up?.query ?? ''
  const now = await captureContext(true, { signal: scope.signal })
  if (next.startsWith('The page is loaded. Highlight')) {
    const r = await callModel(next, now.screenshot, now.activeWindow, {
      ...opts,
      context: now,
      lowDetail: true,
      routedMode: 'locate',
      turnId: undefined,
      history: false
    })
    return { response: r.mode === 'locate' ? r : done, ctx: now }
  }
  const task = `${prompt} (Already done: ${first.summary ?? 'the first step'}. Next: ${next})`
  if (!agentModeAvailable()) {
    // One more plain call on the loaded page; its reply is not chained further.
    log('plan', `follow-up in one call: no agent mode on this model (${next.length} chars)`)
    const r = await callModel(task, now.screenshot, now.activeWindow, {
      ...opts,
      context: now,
      lowDetail: true,
      turnId: undefined,
      history: false
    })
    return {
      response: withNoAgentNote({
        ...r,
        ...(r.mode === 'action' ? { follow_up: undefined } : {})
      } as ModelResponse),
      ctx: now
    }
  }
  log('plan', `follow-up continues as an agent task (${next.length} chars)`)
  return { response: await runAgentTask(task, now, scope.signal, { skipPlan: true }), ctx: now }
}
