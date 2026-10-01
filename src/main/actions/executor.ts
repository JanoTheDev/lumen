// The single place model actions run on the machine: click targets resolved against the
// turn's screen context (resolveTarget), refinement of low-confidence clicks, on-screen
// preview, safety policy and cancellation.
import { shell } from 'electron'
import type { Action, Rect, Target } from '@shared/types'
import { currentFrame, physToLogical, rectCenter } from './coords'
import { toAgentAction, type AgentAction } from './agent-action'
import { assertSafeUrl } from './safety'
import { passesPolicy } from './policy'
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
}

export interface ExecuteResult {
  /** Number of actions sent to the agent (or opened in the browser). */
  executed: number
  cancelled: boolean
  /** The safety policy stopped the batch. */
  blocked: boolean
  /** A scroll hit the bottom of the page; the rest of the batch was skipped. */
  reachedBottom: boolean
  /** Physical rects of the click targets, in order (the verifier diffs around them). */
  targets: Rect[]
}

// Only a v2 agent that advertises dwell understands dwell_pause/dwell_resume.
function canPauseDwell(agent: AgentBridge): boolean {
  return agent.protocol === 2 && agent.hasCapability('dwell')
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
  const result: ExecuteResult = {
    executed: 0,
    cancelled: false,
    blocked: false,
    reachedBottom: false,
    targets: []
  }
  const frame = currentFrame()
  log(
    'step',
    `execute: ${actions.map((a) => a.type).join(', ')} | image ${frame.imgW}x${frame.imgH} → phys ${frame.width}x${frame.height}`
  )

  const pauseDwell = canPauseDwell(agent)
  if (pauseDwell) await agent.request('dwell_pause').catch(() => {})

  let firstClick = true
  let prev: AgentAction | undefined
  try {
    for (const action of actions) {
      if (signal?.aborted) break
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
        if (signal?.aborted) break
        throw e
      }
      if (signal?.aborted) break

      if (!scaled) continue
      if (!scaled.type) {
        console.warn('[execute] skipping action with no type:', JSON.stringify(action))
        continue
      }
      console.log('[execute] running:', JSON.stringify(scaled))
      if (!(await passesPolicy(scaled, prev))) {
        result.blocked = true
        break
      }
      prev = scaled

      if (scaled.type === 'open_url' && scaled.url) {
        console.log('[execute] opening URL:', scaled.url)
        const before = await titleNow(agent)
        await shell.openExternal(assertSafeUrl(scaled.url))
        result.executed++
        await settle(before, signal)
        await agent.execute({ type: 'focus_browser' })
      } else if (scaled.type === 'navigate_url' && scaled.url) {
        console.log('[execute] navigate_url:', scaled.url)
        const before = await titleNow(agent)
        try {
          await agent.execute(scaled)
        } catch (e) {
          // No browser window to navigate: open the (already policy-checked) URL instead.
          log('step', `navigate_url failed (${(e as Error).message}), opening in default browser`)
          await shell.openExternal(assertSafeUrl(scaled.url))
        }
        result.executed++
        // The page has loaded when its title changes or the frames stop moving (max 1.5 s).
        await settle(before, signal)
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
          break
        }
      }
      await sleep(scaled.type === 'hotkey' ? 300 : 150)
    }
  } finally {
    if (preview) highlight.hide()
    if (pauseDwell) await agent.request('dwell_resume').catch(() => {})
  }

  result.cancelled = !!signal?.aborted
  if (result.cancelled) log('skip', 'execution aborted by user')
  return result
}
