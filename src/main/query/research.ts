// Multi-step paths: the autonomous research loop and plan + verified execution.
import { shell } from 'electron'
import type { Action, ModelResponse } from '@shared/types'
import { buildPlan, executePlan, runResearchAgent } from './task-planner'
import type { CancelScope } from './cancel'
import { callClaude, type CallOptions } from '../claude'
import { requireAgent } from '../agent/instance'
import { currentFrame } from '../actions/coords'
import { toAgentAction, type AgentAction } from '../actions/agent-action'
import { assertSafeUrl } from '../actions/safety'
import { passesPolicy } from '../actions/policy'
import { log, type Timer } from '../logger'
import { setStatus, type StatusKind } from '../windows/status'
import { sleep } from '../util'

async function runBatch(actions: Action[], scope: CancelScope): Promise<void> {
  const agent = requireAgent()
  const frame = currentFrame()
  let prev: AgentAction | undefined
  for (const action of actions) {
    if (scope.cancelled) break
    const scaled = toAgentAction(action, frame)
    if (!(await passesPolicy(scaled, prev))) break
    prev = scaled
    if (scaled.type === 'open_url' && scaled.url) {
      await shell.openExternal(assertSafeUrl(scaled.url))
      await sleep(400)
      await agent.execute({ type: 'focus_browser' })
    } else if (scaled.type === 'navigate_url' && scaled.url) {
      await agent.execute(scaled)
      await sleep(1500)
    } else {
      await agent.execute(scaled)
    }
    await sleep(scaled.type === 'hotkey' ? 300 : 150)
  }
}

/** Autonomous loop: keep navigating/clicking/scrolling until the info is found or stuck. */
export function runResearch(
  prompt: string,
  activeWindow: string,
  opts: CallOptions,
  scope: CancelScope
): Promise<ModelResponse> {
  const agent = requireAgent()
  return runResearchAgent(
    prompt,
    activeWindow,
    (p, s, w) => callClaude(p, s, w, opts),
    () => agent.screenshot(),
    (actions) => runBatch(actions as Action[], scope),
    () => {},
    scope.signal
  )
}

/** Multi-step: build a plan, then execute it with per-step verification. */
export async function runPlanned(
  prompt: string,
  activeWindow: string,
  opts: CallOptions,
  scope: CancelScope,
  timer: Timer
): Promise<ModelResponse> {
  const agent = requireAgent()
  const plan = await buildPlan(prompt, null, activeWindow, scope.signal)
  timer.split('buildPlan done')
  const result = await executePlan(
    plan,
    activeWindow,
    (p, s, w) => callClaude(p, s, w, opts),
    () => agent.screenshot(),
    (actions) => runBatch(actions as Action[], scope),
    (progress) => {
      const p = progress as { stepIndex?: number; totalSteps?: number; description?: string; status?: string }
      if (p.stepIndex && p.totalSteps && p.description) {
        const statusKind: StatusKind = p.status === 'failed' ? 'error' : 'step'
        setStatus(statusKind, p.description, { index: p.stepIndex, total: p.totalSteps })
      }
    },
    scope.signal
  )
  timer.split('executePlan done')
  // Plan already executed every step. Strip any trailing follow_up so the renderer
  // doesn't fire an extra query that would re-trigger actions outside the plan.
  if (result.mode === 'action' && result.follow_up) {
    log('plan', 'stripping trailing follow_up from planned result')
    delete result.follow_up
  }
  return result
}
