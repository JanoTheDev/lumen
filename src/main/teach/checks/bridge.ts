// bridge: asks an in-app bridge (Blender add-on, OBS websocket …) whether `expect` holds.
// Polls at 1 Hz; stops polling once the port says no bridge is connected ('unknown').
import type { CheckSpec } from '../lesson'
import type { CheckResult } from '../ports'
import type { CheckContext, CheckHandle } from './types'
import { poll, settleable } from './types'

export const BRIDGE_POLL_MS = 1000

export function start(
  spec: Extract<CheckSpec, { type: 'bridge' }>,
  ctx: CheckContext
): CheckHandle {
  const r = settleable()
  const ac = new AbortController()
  const ask = (): Promise<CheckResult> =>
    ctx.ports.bridge.query(spec.app, spec.expect, ac.signal).catch(() => 'unknown' as const)
  const p = poll(ctx.clock, BRIDGE_POLL_MS, async () => {
    const res = await ask()
    if (res === 'pass') r.settle('pass')
    if (res !== 'fail') p.stop()
  })
  return {
    result: r.promise,
    evaluate: async () => (r.passed() ? 'pass' : ask()),
    cancel: () => {
      p.stop()
      ac.abort()
      r.settle('unknown')
    }
  }
}
