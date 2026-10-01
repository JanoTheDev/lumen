// The lesson engine's BridgePort over a set of app bridges.
import type { BridgePort, CheckResult } from '../ports'
import { matchExpect, type BridgeState } from './expect'
import type { AppBridge } from './types'

/**
 * The BridgePort: asks the app's bridge and matches `expect`. The first answer for a check
 * (one AbortSignal per running check) is its baseline for "changed" keys and last_operator.
 */
export function makeBridgePort(bridges: () => Map<string, AppBridge>): BridgePort {
  const baselines = new WeakMap<AbortSignal, BridgeState>()
  return {
    async query(appId, question, signal): Promise<CheckResult> {
      const b = bridges().get(appId)
      if (!b) return 'unknown'
      const state = await b.state(question, signal).catch(() => null)
      if (!state || signal?.aborted) return 'unknown'
      let base: BridgeState | null = null
      if (signal) {
        base = baselines.get(signal) ?? state
        if (!baselines.has(signal)) baselines.set(signal, state)
      }
      return matchExpect(state, question, base) ? 'pass' : 'fail'
    }
  }
}
