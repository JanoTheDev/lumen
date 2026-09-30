// Multi-step paths: the autonomous research loop and plan + verified execution.
import type { Action, ModelResponse } from '@shared/types'
import { buildPlan, executePlan, runResearchAgent } from './task-planner'
import type { CancelScope } from './cancel'
import { callModel, type CallOptions } from '../ai'
import { requireAgent } from '../agent/instance'
import { executeActions } from '../actions/executor'
import { log, type Timer } from '../logger'
import { setStatus, type StatusKind } from '../windows/status'

// Planner and research batches run through the same executor as renderer actions.
async function runBatch(actions: Action[], scope: CancelScope): Promise<void> {
  await executeActions(actions, { signal: scope.signal })
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
    (p, s, w) => callModel(p, s, w, opts),
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
    (p, s, w) => callModel(p, s, w, opts),
    () => agent.screenshot(),
    (actions) => runBatch(actions as Action[], scope),
    (progress) => {
      const p = progress as {
        stepIndex?: number
        totalSteps?: number
        description?: string
        status?: string
      }
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
