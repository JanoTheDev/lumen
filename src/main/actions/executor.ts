// The single place model actions run on the machine: coordinate conversion, optional
// Computer Use refinement, on-screen preview, safety policy and cancellation.
import { shell } from 'electron'
import type { Action } from '@shared/types'
import { currentFrame, imageRectToPhys, imageToPhys, physRectToLogical, physToLogical, rectCenter } from './coords'
import { toAgentAction, type AgentAction } from './agent-action'
import { assertSafeUrl } from './safety'
import { passesPolicy } from './policy'
import { requireAgent } from '../agent/instance'
import type { AgentBridge } from '../agent/bridge'
import { findClickCoordinates } from '../ai/computer-use'
import { isBrowser } from '../ai/app-context'
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
  agent: AgentBridge,
  description: string,
  signal: AbortSignal | undefined
): Promise<{ x: number; y: number } | null> {
  const freshShot = await agent.screenshot()
  if (!freshShot) return null
  const frame = currentFrame()
  const refined = await findClickCoordinates(freshShot, description, frame.imgW, frame.imgH, signal)
  return refined ? imageToPhys(frame, refined) : null
}

// Resolves one model action into what the agent runs, refining and previewing clicks.
async function resolve(
  agent: AgentBridge,
  action: Action,
  opts: Required<Pick<ExecuteOptions, 'refine' | 'preview'>> & { signal?: AbortSignal }
): Promise<AgentAction> {
  const frame = currentFrame()
  const scaled = toAgentAction(action, frame)
  const canRefine = opts.refine && !!process.env.ANTHROPIC_API_KEY

  if (action.type === 'click_bbox' && action.bbox) {
    const physRect = imageRectToPhys(frame, action.bbox)
    let target = rectCenter(physRect)
    // Computer Use is tuned for UI clicking and beats the model's own bbox centre.
    if (canRefine && action.description) {
      console.log(`[execute] click_bbox CU lookup: "${action.description}"`)
      const refined = await refineClick(agent, action.description, opts.signal)
      if (refined) {
        target = refined
        console.log(`[execute] click_bbox CU refined → (${target.x},${target.y})`)
      } else {
        console.log('[execute] click_bbox CU returned null, using bbox center')
      }
    }
    if (opts.preview) {
      highlight.send('screen:highlights', [{ label: 'Clicking here', target_hint: '', bbox: physRectToLogical(physRect) }])
      highlight.show()
      await sleep(600)
      highlight.hide()
    }
    return { type: 'click', x: Math.round(target.x), y: Math.round(target.y), button: action.button ?? 'left' }
  }

  if (action.type === 'click_element' && action.bbox && action.text && canRefine) {
    // In a browser, Computer Use beats the OCR lookup the agent would do.
    if (isBrowser(await agent.activeWindow())) {
      const p = await refineClick(agent, action.text, opts.signal)
      if (p) {
        console.log(`[execute] click_element CU refined "${action.text}" → (${p.x},${p.y})`)
        return { type: 'click', x: p.x, y: p.y, button: action.button ?? 'left' }
      }
    }
  }
  return scaled
}

export async function executeActions(actions: Action[], opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const agent = requireAgent()
  const refine = opts.refine ?? true
  const preview = opts.preview ?? true
  const { signal } = opts
  const result: ExecuteResult = { executed: 0, cancelled: false, blocked: false, reachedBottom: false }
  const frame = currentFrame()
  log('step', `execute: ${actions.map(a => a.type).join(', ')} | image ${frame.imgW}x${frame.imgH} → phys ${frame.width}x${frame.height}`)

  const pauseDwell = canPauseDwell(agent)
  if (pauseDwell) await agent.request('dwell_pause').catch(() => {})

  let firstClick = true
  let prev: AgentAction | undefined
  try {
    for (const action of actions) {
      if (signal?.aborted) break
      const scaled = await resolve(agent, action, { refine, preview, signal })
      if (signal?.aborted) break

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
        await agent.execute(scaled)
        result.executed++
        await sleep(1500) // wait for page to finish loading before next action
      } else {
        // Show pointer preview before first click
        if (preview && firstClick && scaled.type === 'click' && scaled.x != null && scaled.y != null) {
          firstClick = false
          highlight.send('screen:pointer', { ...physToLogical({ x: scaled.x, y: scaled.y }), text: 'Clicking here…' })
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
