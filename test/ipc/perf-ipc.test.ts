import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { invokeHandler, resetElectronMock } from '../helpers/electron-mock'
import { registerPerfIpc } from '../../src/main/ipc/perf'
import { installTurnMetrics, TurnMetrics } from '../../src/main/ai/turn-metrics'
import { bus } from '../../src/main/bus'

let t = 0
installTurnMetrics(
  new TurnMetrics(
    () => t,
    () => {}
  )
)

beforeEach(() => {
  resetElectronMock()
  registerPerfIpc()
})

describe('perf:last-turn', () => {
  it('is null before any turn, then the last turn’s stages', async () => {
    expect(await invokeHandler('perf:last-turn')).toBeNull()
    t = 1000
    bus.emit({ type: 'voice.stopped' })
    t = 1300
    bus.emit({ type: 'query.started', turnId: 'q1', prompt: 'hi' })
    t = 2400
    bus.emit({ type: 'query.delta', turnId: 'q1', delta: 'H' })
    t = 3000
    bus.emit({
      type: 'query.done',
      turnId: 'q1',
      response: { mode: 'answer', text: 'Hello' } as never
    })
    expect(await invokeHandler('perf:last-turn')).toEqual({
      at: 3000,
      mode: 'answer',
      outcome: 'done',
      stages: [
        { name: 'Speech to text', ms: 300, budgetMs: 400 },
        { name: 'First reply', ms: 1100, budgetMs: 900 },
        { name: 'Whole turn', ms: 2000, budgetMs: 3000 }
      ]
    })
  })
})
