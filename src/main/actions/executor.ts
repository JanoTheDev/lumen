// The single place model actions run on the machine: click targets resolved against the
// turn's screen context (resolveTarget), refinement of low-confidence clicks, on-screen
// preview, safety policy and cancellation. Every action passes the policy gate (evaluate,
// confirm, audit) before it runs, so no caller can skip it.
import { shell } from 'electron'
import type { Action, InputStep, Rect, Target, UiaAction } from '@shared/types'
import { currentFrame, physToLogical, rectCenter } from './coords'
import { toAgentAction, type AgentAction } from './agent-action'
import { assertLaunchableUrl, type Origin, type Risk, type TaskState } from './safety'
import { gate, newTaskId } from './policy'
import { redactForLog } from './redact'
import { requireAgent } from '../agent/instance'
import type { AgentBridge } from '../agent/bridge'
import { canRefine, needsRefine, refineTarget } from '../query/refine'
import {
  describeResolved,
  groundingNow,
  LOW_CONFIDENCE,
  resolveFirst,
  resolveTarget,
  type GroundingContext,
  type ResolvedTarget
} from '../query/resolve-target'
import { log } from '../logger'
import * as highlight from '../windows/highlight'
import { setStatus } from '../windows/status'
import { sleep } from '../util'
import { waitForSettle } from '../ai/observe'
import { armCancel } from '../speech/wake/arm'
import { holdDwell } from '../a11y/dwell'

// How long an uncertain target stays on screen before the click (cancel window).
const CONFIRM_MS = 2500

export interface ExecuteOptions {
  /** Zoom-crop refine for low-confidence and point click targets (T14). Default true. */
  refine?: boolean
  /** Refine every click target, whatever its confidence (the loop's retry). */
  forceRefine?: boolean
  /** Show the target highlight / pointer before clicking. Default true. */
  preview?: boolean
  signal?: AbortSignal
  /** Who asked (safety-policy ctx.origin). Default "agent", the strictest model origin. */
  origin?: Origin
  /** The user's words for this task. */
  userText?: string
  /** The user already said yes to this batch (transcript confirm). */
  approved?: boolean
  /** Audit task id; one per call when absent. */
  taskId?: string
  /** Sites and apps the task already used (agent runner). */
  task?: TaskState
  /** Text the agent read this task (injection check). */
  observedText?: string
  /** Pause after each action (default 150 ms, 300 ms after a hotkey). */
  pauseMs?: number
}

export interface ExecuteResult {
  /** Number of actions sent to the agent (or opened in the browser). */
  executed: number
  cancelled: boolean
  /** The safety policy (or the user at its confirm) stopped the batch. */
  blocked: boolean
  /** Why the batch stopped: E_DENIED with the policy reason. */
  denied?: { code: 'E_DENIED'; reason: string }
  /** A scroll hit the bottom of the page; the rest of the batch was skipped. */
  reachedBottom: boolean
  /** Physical rects of the click targets, in order (the verifier diffs around them). */
  targets: Rect[]
  /** Highest policy risk among the actions that ran. */
  maxRisk: Exclude<Risk, 'blocked'>
}

/** Shows the uncertain target and gives the user a moment to cancel (Esc / "cancel"). */
async function confirmLowConfidence(
  r: ResolvedTarget,
  label: string,
  signal?: AbortSignal
): Promise<void> {
  log('step', `low confidence ${r.confidence} for "${label}", asking before the click`)
  highlight.send('screen:highlights', [
    { label: 'Is it this one?', target_hint: label, bbox: r.logicalRect }
  ])
  highlight.show()
  setStatus(
    'acting',
    `Not sure: is it this one? Say "cancel" to stop.`,
    undefined,
    CONFIRM_MS + 600
  )
  await sleep(CONFIRM_MS)
  if (!signal?.aborted) highlight.hide()
}

/** How a click action is found on screen: its targets in priority order. */
interface ClickPlan {
  targets: Target[]
  /** What the click is for (refine prompt, logs). */
  label?: string
  /** Text clicks the agent can still search for itself when main cannot resolve them. */
  agentFallback?: boolean
}

function clickPlan(action: Action): ClickPlan | null {
  switch (action.type) {
    case 'click_target':
      return { targets: [action.target], label: action.description ?? labelOf(action.target) }
    case 'click_bbox':
      return { targets: [{ kind: 'rect', ...action.bbox, frame: '1' }], label: action.description }
    case 'click_element':
      return {
        targets: [
          { kind: 'text', text: action.text },
          ...(action.bbox ? [{ kind: 'rect' as const, ...action.bbox, frame: '1' }] : [])
        ],
        label: action.text,
        agentFallback: true
      }
    case 'click_nth_element':
      return {
        targets: [{ kind: 'text', text: action.text, nth: action.n }],
        label: `${action.text} #${action.n}`,
        agentFallback: true
      }
    default:
      return null
  }
}

function labelOf(t: Target): string | undefined {
  return t.kind === 'text' ? t.text : undefined
}

/** Resolves a click; null when the target is not on screen. */
async function resolveClick(
  plan: ClickPlan,
  ctx: GroundingContext
): Promise<ResolvedTarget | null> {
  // Text first; the bbox hint only counts when OCR ran and found nothing, otherwise the agent
  // does its own UIA/OCR search (click_element) as before.
  const [first, ...rest] = plan.targets
  const r = await resolveTarget(first, ctx)
  if (r || !rest.length) return r
  if (plan.agentFallback && !(ctx.ocr && (await ctx.ocr()))) return null
  return resolveFirst(rest, ctx)
}

// Resolves one model action into what the agent runs, refining and previewing clicks.
async function resolve(
  action: Action,
  opts: Required<Pick<ExecuteOptions, 'refine' | 'preview' | 'forceRefine'>> & {
    signal?: AbortSignal
    targets: Rect[]
  }
): Promise<AgentAction | null> {
  const plan = clickPlan(action)
  if (!plan) return toAgentAction(action, currentFrame())
  const ctx: GroundingContext = { ...groundingNow(), signal: opts.signal }
  const r = await resolveClick(plan, ctx)
  if (!r) {
    if (plan.agentFallback) {
      log('step', `${action.type} "${plan.label}": not resolved here, agent searches itself`)
      return toAgentAction(action, currentFrame())
    }
    log('fail', `${action.type} "${plan.label ?? ''}": target not on screen, skipped`)
    return null
  }
  log('step', `${action.type} "${(plan.label ?? '').slice(0, 40)}": ${describeResolved(r)}`)
  let resolved = r
  if (opts.refine && plan.label && (opts.forceRefine || needsRefine(r)) && canRefine()) {
    const out = await refineTarget(r, plan.label, opts.signal)
    resolved = out.target
    log('step', `refine ${out.outcome} in ${out.ms}ms: ${describeResolved(resolved)}`)
    if (opts.signal?.aborted) return null
    if (out.outcome !== 'skipped' && resolved.confidence < LOW_CONFIDENCE) {
      await confirmLowConfidence(resolved, plan.label, opts.signal)
      if (opts.signal?.aborted) return null
    }
  }
  const target = rectCenter(resolved.physRect)
  opts.targets.push(resolved.physRect)
  if (opts.preview) {
    highlight.send('screen:highlights', [
      { label: 'Clicking here', target_hint: '', bbox: resolved.logicalRect }
    ])
    highlight.show()
    await sleep(600)
    highlight.hide()
  }
  const button = 'button' in action ? action.button : undefined
  return {
    type: 'click',
    x: Math.round(target.x),
    y: Math.round(target.y),
    button: button ?? 'left'
  }
}

/** Waits for the screen to react (see waitForSettle); a cancel just ends the wait. */
async function settle(title: string, signal?: AbortSignal): Promise<void> {
  await waitForSettle({ title }, signal).catch((e) => {
    if (!signal?.aborted) log('fail', `settle wait failed: ${(e as Error).message}`)
  })
}

async function titleNow(agent: AgentBridge): Promise<string> {
  return agent.activeWindow().catch(() => '')
}

export async function executeActions(
  actions: Action[],
  opts: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const agent = requireAgent()
  const refine = opts.refine ?? true
  const preview = opts.preview ?? true
  const forceRefine = opts.forceRefine ?? false
  const { signal } = opts
  const gateCtx = {
    origin: opts.origin ?? ('agent' as const),
    taskId: opts.taskId ?? newTaskId(),
    userText: opts.userText,
    approved: opts.approved,
    task: opts.task,
    observedText: opts.observedText
  }
  const result: ExecuteResult = {
    executed: 0,
    cancelled: false,
    blocked: false,
    reachedBottom: false,
    targets: [],
    maxRisk: 'low'
  }
  const frame = currentFrame()
  log(
    'step',
    `execute: ${actions.map((a) => a.type).join(', ')} | image ${frame.imgW}x${frame.imgH} → phys ${frame.width}x${frame.height}`
  )

  // No dwell may fire while Lumen moves the mouse (a user pause is kept separately).
  const releaseDwell = holdDwell('automation')
  const disarmCancel = armCancel()

  let firstClick = true
  let prevType: string | undefined
  try {
    for (const action of actions) {
      if (signal?.aborted) break
      const g = await gate(action, gateCtx, prevType)
      if (!g.ok) {
        result.blocked = true
        result.denied = { code: 'E_DENIED', reason: g.decision.reason }
        break
      }
      prevType = action.type
      const risk = g.decision.risk
      if (risk === 'high' || (risk === 'medium' && result.maxRisk === 'low')) result.maxRisk = risk
      if (signal?.aborted) {
        g.finish('cancelled')
        break
      }
      let scaled: AgentAction | null
      try {
        scaled = await resolve(action, {
          refine,
          preview,
          forceRefine,
          signal,
          targets: result.targets
        })
      } catch (e) {
        g.finish(signal?.aborted ? 'cancelled' : 'error')
        if (signal?.aborted) break
        throw e
      }
      if (signal?.aborted) {
        g.finish('cancelled')
        break
      }

      if (!scaled?.type) {
        if (scaled) console.warn('[execute] skipping action with no type:', JSON.stringify(action))
        g.finish('error')
        continue
      }
      console.log('[execute] running:', redactForLog(JSON.stringify(scaled)))
      let stop: boolean
      try {
        stop = await run(scaled)
        g.finish('ok')
      } catch (e) {
        g.finish(signal?.aborted ? 'cancelled' : 'error')
        throw e
      }
      if (stop) break
      await sleep(opts.pauseMs ?? (scaled.type === 'hotkey' ? 300 : 150))
    }
  } finally {
    disarmCancel()
    if (preview) highlight.hide()
    releaseDwell()
  }

  result.cancelled = !!signal?.aborted
  if (result.cancelled) log('skip', 'execution aborted by user')
  return result

  /** Runs one resolved action; true = stop the batch (the page hit its bottom). */
  async function run(scaled: AgentAction): Promise<boolean> {
    if (scaled.type === 'open_url' && scaled.url) {
      console.log('[execute] opening URL:', scaled.url)
      const url = assertLaunchableUrl(scaled.url)
      const web = /^https?:/i.test(url)
      const before = web ? await titleNow(agent) : ''
      await shell.openExternal(url)
      result.executed++
      if (web) {
        await settle(before, signal)
        await agent.execute({ type: 'focus_browser' })
      }
    } else if (scaled.type === 'navigate_url' && scaled.url && !/^https?:/i.test(scaled.url)) {
      // mailto: / ms-settings: (already policy-checked) have no tab to navigate.
      await shell.openExternal(assertLaunchableUrl(scaled.url))
      result.executed++
    } else if (scaled.type === 'navigate_url' && scaled.url) {
      console.log('[execute] navigate_url:', scaled.url)
      const before = await titleNow(agent)
      try {
        await agent.execute(scaled)
      } catch (e) {
        // No browser window to navigate: open the (already policy-checked) URL instead.
        log('step', `navigate_url failed (${(e as Error).message}), opening in default browser`)
        await shell.openExternal(assertLaunchableUrl(scaled.url))
      }
      result.executed++
      // The page has loaded when its title changes or the frames stop moving (max 1.5 s).
      await settle(before, signal)
    } else if (scaled.type === 'uia_act') {
      // UIA patterns: the real pointer does not move (ghost cursor).
      const a = scaled as AgentAction & { elementId?: string; action?: UiaAction; value?: string }
      if (!a.elementId || !a.action) throw new Error('uia_act needs elementId and action')
      await agent.request(
        'uia_act',
        {
          elementId: a.elementId,
          action: a.action,
          ...(a.value !== undefined ? { value: a.value } : {})
        },
        { signal }
      )
      result.executed++
    } else if (scaled.type === 'input') {
      const steps = (scaled as AgentAction & { steps?: InputStep[] }).steps ?? []
      await agent.request('input', { steps }, { signal })
      result.executed++
    } else {
      // Show pointer preview before first click
      if (
        preview &&
        firstClick &&
        scaled.type === 'click' &&
        scaled.x != null &&
        scaled.y != null
      ) {
        firstClick = false
        highlight.send('screen:pointer', {
          ...physToLogical({ x: scaled.x, y: scaled.y }),
          text: 'Clicking here…'
        })
        highlight.show()
        await sleep(300)
      }
      const actionResult = (await agent.execute(scaled)) as Record<string, unknown> | null
      result.executed++
      if (actionResult?.reached_bottom) {
        console.log('[execute] reached_bottom detected — stopping action loop')
        result.reachedBottom = true
        return true
      }
    }
    return false
  }
}
