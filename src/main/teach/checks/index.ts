// Starts the check tree of a step (plans 07 T14). Leaf checks run concurrently; anyOf passes
// on the first pass, allOf once every child has passed.
import type { CheckSpec } from '../lesson'
import type { CheckResult } from '../ports'
import * as bridge from './bridge'
import * as keypress from './keypress'
import * as manual from './manual'
import * as uiaEvent from './uia-event'
import * as vision from './vision'
import * as windowTitle from './window-title'
import type { CheckContext, CheckHandle } from './types'
import { settleable } from './types'

export type { CheckContext, CheckHandle, VisionBudget } from './types'
export { newBudget } from './types'

/** anyOf: any pass → pass; else any fail → fail; else unknown. */
export function combineAny(results: CheckResult[]): CheckResult {
  if (results.includes('pass')) return 'pass'
  return results.includes('fail') ? 'fail' : 'unknown'
}

/** allOf: all pass → pass; any fail → fail; else unknown. */
export function combineAll(results: CheckResult[]): CheckResult {
  if (results.every((r) => r === 'pass')) return 'pass'
  return results.includes('fail') ? 'fail' : 'unknown'
}

function group(
  spec: Extract<CheckSpec, { type: 'anyOf' | 'allOf' }>,
  ctx: CheckContext
): CheckHandle {
  const children = spec.checks.map((c) => startCheck(c, ctx))
  const passed = new Set<number>()
  const r = settleable()
  const all = spec.type === 'allOf'
  children.forEach((h, i) => {
    void h.result.then((res) => {
      if (res !== 'pass') return
      passed.add(i)
      if (!all || passed.size === children.length) r.settle('pass')
    })
  })
  return {
    result: r.promise,
    evaluate: async () => {
      if (r.passed()) return 'pass'
      const results = await Promise.all(
        children.map((h, i) =>
          passed.has(i) ? 'pass' : h.evaluate().catch(() => 'unknown' as const)
        )
      )
      const res = all ? combineAll(results) : combineAny(results)
      if (res === 'pass') r.settle('pass')
      return res
    },
    cancel: () => {
      for (const h of children) h.cancel()
      r.settle('unknown')
    }
  }
}

export function startCheck(spec: CheckSpec, ctx: CheckContext): CheckHandle {
  switch (spec.type) {
    case 'uia-event':
      return uiaEvent.start(spec, ctx)
    case 'window-title':
      return windowTitle.start(spec, ctx)
    case 'vision':
      return vision.start(spec, ctx)
    case 'bridge':
      return bridge.start(spec, ctx)
    case 'keypress':
      return keypress.start(spec, ctx)
    case 'manual':
      return manual.start()
    case 'anyOf':
    case 'allOf':
      return group(spec, ctx)
  }
}
