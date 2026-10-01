// The single place model actions run on the machine: click targets resolved against the
// turn's screen context (resolveTarget), refinement of low-confidence clicks, on-screen
// preview, safety policy and cancellation.
import { shell } from 'electron'
import type { Action, Target } from '@shared/types'
import { currentFrame, imageToPhys, physToLogical, rectCenter } from './coords'
import { toAgentAction, type AgentAction } from './agent-action'
import { assertSafeUrl } from './safety'
import { passesPolicy } from './policy'
import { requireAgent } from '../agent/instance'
import type { AgentBridge } from '../agent/bridge'
import { findClickCoordinates } from '../ai/computer-use'
import { captureScreenshot } from '../query/capture'
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
import { sleep } from '../util'

export interface ExecuteOptions {
  /** Refine click targets with Computer Use when an Anthropic key is set. Default true. */
  refine?: boolean
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
}

// Only a v2 agent that advertises dwell understands dwell_pause/dwell_resume.
function canPauseDwell(agent: AgentBridge): boolean {
  return agent.protocol === 2 && agent.hasCapability('dwell')
}

async function refineClick(
  description: string,
  signal: AbortSignal | undefined
): Promise<{ x: number; y: number } | null> {
  // Same monitor + geometry as the turn's frame (currentFrame follows the capture).
  const freshShot = await captureScreenshot(signal)
  const frame = currentFrame()
  const refined = await findClickCoordinates(freshShot, description, frame.imgW, frame.imgH, signal)
  return refined ? imageToPhys(frame, refined) : null
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
  opts: Required<Pick<ExecuteOptions, 'refine' | 'preview'>> & { signal?: AbortSignal }
): Promise<AgentAction | null> {
  const plan = clickPlan(action)
  if (!plan) return toAgentAction(action, currentFrame())
  const ctx = groundingNow()
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
  let target = rectCenter(r.physRect)

  const canRefine = opts.refine && !!process.env.ANTHROPIC_API_KEY && !!plan.label
  if (canRefine && (r.confidence < LOW_CONFIDENCE || r.source === 'point')) {
    const refined = await refineClick(plan.label!, opts.signal)
    if (refined) {
      target = refined
      log('step', `refined → (${target.x},${target.y})`)
    }
  }
  if (opts.preview) {
    highlight.send('screen:highlights', [
      { label: 'Clicking here', target_hint: '', bbox: r.logicalRect }
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

export async function executeActions(
  actions: Action[],
  opts: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const agent = requireAgent()
  const refine = opts.refine ?? true
  const preview = opts.preview ?? true
  const { signal } = opts
  const result: ExecuteResult = {
    executed: 0,
    cancelled: false,
    blocked: false,
    reachedBottom: false
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
      const scaled = await resolve(action, { refine, preview, signal })
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
        await shell.openExternal(assertSafeUrl(scaled.url))
        result.executed++
        await sleep(400)
        await agent.execute({ type: 'focus_browser' })
      } else if (scaled.type === 'navigate_url' && scaled.url) {
        console.log('[execute] navigate_url:', scaled.url)
        try {
          await agent.execute(scaled)
        } catch (e) {
          // No browser window to navigate: open the (already policy-checked) URL instead.
          log('step', `navigate_url failed (${(e as Error).message}), opening in default browser`)
          await shell.openExternal(assertSafeUrl(scaled.url))
        }
        result.executed++
        await sleep(1500) // wait for page to finish loading before next action
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
