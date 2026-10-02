import { describe, expect, it } from 'vitest'
import { BackgroundManager, type RunOutcome } from '../../src/main/agent-mode/background/manager'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('monthly limits on Run again (M2)', () => {
  it('a refused run again ends failed with the reason and never runs', async () => {
    let refuse: string | null = null
    const runs: string[] = []
    let n = 0
    const m = new BackgroundManager({
      max: () => 3,
      run: async (ctl): Promise<RunOutcome> => {
        runs.push(ctl.task().id)
        return { status: 'done', summary: 'ok' }
      },
      emit: () => {},
      refuse: () => refuse,
      now: () => 1,
      newId: () => `t${n++}`
    })
    const first = m.start({ prompt: 'morning check', origin: 'routine', routineId: 'r1' })
    await tick()
    expect(m.get(first.id)?.phase).toBe('done')
    refuse = 'Your morning check automation is paused: it reached its monthly limit.'
    const again = m.runAgain(first.id)
    await tick()
    expect(runs).toEqual([first.id])
    expect(m.get(again!.id)).toMatchObject({
      phase: 'failed',
      result: { summary: refuse }
    })
  })
})
