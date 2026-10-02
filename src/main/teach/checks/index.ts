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

/**
 * anyOf: a connected bridge that says "not done" is decisive, so a `manual` alternative's
 * pass on the user's "done" does not count then (the step answers "not yet" with its hints).
 * Without an answering bridge, manual stays the fallback.
 */
export function overruleManual(
  checks: CheckSpec[],
  results: CheckResult[],
  ctx?: Pick<CheckContext, 'log'>
): CheckResult[] {
  const bridgeSaysNo = checks.some((c, i) => c.type === 'bridge' && results[i] === 'fail')
  if (!bridgeSaysNo || !checks.some((c) => c.type === 'manual')) return results
  ctx?.log('bridge says not done; "done" alone does not pass')
  return results.map((r, i) => (checks[i].type === 'manual' ? 'unknown' : r))
}

/** Starts `start` only once `gate` resolves true; until then it answers unknown. */
function deferred(gate: Promise<boolean>, start: () => CheckHandle): CheckHandle {
  const r = settleable()
  let h: CheckHandle | null = null
  let cancelled = false
  void gate.then((go) => {
    if (!go || cancelled) return
    h = start()
    void h.result.then(r.settle)
  })
  return {
    result: r.promise,
    evaluate: () => (h ? h.evaluate() : Promise.resolve('unknown' as const)),
    cancel: () => {
      cancelled = true
      h?.cancel()
      r.settle('unknown')
    }
  }
}

function group(
  spec: Extract<CheckSpec, { type: 'anyOf' | 'allOf' }>,
  ctx: CheckContext
): CheckHandle {
  // anyOf with a bridge: vision (costly) only runs when that bridge does not answer.
  const viaBridge = spec.type === 'anyOf' ? spec.checks.find((c) => c.type === 'bridge') : undefined
  let bridgeAbsent: Promise<boolean> | null = null
  if (viaBridge?.type === 'bridge' && spec.checks.some((c) => c.type === 'vision'))
    bridgeAbsent = ctx.ports.bridge
      .query(viaBridge.app, viaBridge.expect)
      .then((res) => res === 'unknown')
      .catch(() => true)
  const children = spec.checks.map((c) =>
    bridgeAbsent && c.type === 'vision'
      ? deferred(bridgeAbsent, () => startCheck(c, ctx))
      : startCheck(c, ctx)
  )
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
      const res = all ? combineAll(results) : combineAny(overruleManual(spec.checks, results, ctx))
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
