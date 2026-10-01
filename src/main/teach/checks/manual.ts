// manual: passes when the user says "done" or "next" (the engine then calls evaluate()).
import type { CheckHandle } from './types'
import { settleable } from './types'

export function start(): CheckHandle {
  const r = settleable()
  return {
    result: r.promise,
    evaluate: async () => 'pass',
    cancel: () => r.settle('unknown')
  }
}
