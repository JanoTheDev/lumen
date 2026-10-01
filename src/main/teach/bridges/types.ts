// An app bridge: exact app state for lesson checks (07 T23–T25).
import type { BridgeStatus } from '@shared/channels'
import type { BridgeState } from './expect'

export interface AppBridge {
  /** The lesson `app` id it answers for (skill id). */
  id: string
  name: string
  /** The state to match the check's `expect` against; null when not connected. */
  state(question: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeState | null>
  /** A live probe for Settings and the install offer. */
  status(): Promise<BridgeStatus>
}
