import { describe, expect, it } from 'vitest'
import {
  BackgroundManager,
  type RunOutcome,
  type StartInput
} from '../../src/main/agent-mode/background/manager'
import { currentUsageScope, withUsageScope, type UsageScope } from '../../src/main/usage/scope'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(): {
  m: BackgroundManager
  seen: Record<string, UsageScope>
  finish: Record<string, () => void>
} {
  const seen: Record<string, UsageScope> = {}
  const finish: Record<string, () => void> = {}
  let n = 0
  const m = new BackgroundManager({
    max: () => 1,
    run: (ctl) =>
      new Promise<RunOutcome>((resolve) => {
        seen[ctl.task().id] = { ...currentUsageScope() }
        finish[ctl.task().id] = () => resolve({ status: 'done', summary: 'ok' })
      }),
    emit: () => {},
    now: () => 1,
    newId: () => `t${n++}`
  })
  return { m, seen, finish }
}

const buddyScope: UsageScope = {
  origin: 'buddy',
  buddyId: 'b1',
  taskId: 'P',
  automationId: 'auto1'
}

describe('background task usage scope (H1)', () => {
  it('a queued task never takes the scope of the task that finished before it', async () => {
    const { m, seen, finish } = setup()
    const helper: StartInput = { prompt: 'helper', origin: 'buddy', parentId: 'P', buddyId: 'b1' }
    withUsageScope(buddyScope, () => m.start(helper))
    m.start({ prompt: 'my own thing', origin: 'voice' })
    await tick()
    finish['t0']()
    await tick()
    await tick()
    expect(seen['t1']).toEqual({ origin: 'background', feature: 'agent-step', taskId: 't1' })
    expect(seen['t0']).toMatchObject({ buddyId: 'b1', parentTaskId: 'P', taskId: 't0' })
  })

  it('a task started inside a running scope (a limits notice) does not inherit it', async () => {
    const { m, seen, finish } = setup()
    m.start({ prompt: 'first', origin: 'voice' })
    withUsageScope(buddyScope, () => m.start({ prompt: 'limit notice', origin: 'voice' }))
    m.start({ prompt: 'mine', origin: 'voice' })
    await tick()
    finish['t0']()
    await tick()
    expect(seen['t1']).toEqual({ origin: 'background', feature: 'agent-step', taskId: 't1' })
    finish['t1']()
    await tick()
    await tick()
    expect(seen['t2']).toEqual({ origin: 'background', feature: 'agent-step', taskId: 't2' })
  })

  it("a helper keeps its parent's owner ids", async () => {
    const { m, seen, finish } = setup()
    withUsageScope({ origin: 'agent', taskId: 'fg', skillId: 'mail' }, () =>
      m.start({ prompt: 'helper', origin: 'agent', parentId: 'fg' })
    )
    // A stranger's scope with another taskId is not a parent.
    withUsageScope({ origin: 'agent', taskId: 'other', skillId: 'x' }, () =>
      m.start({ prompt: 'helper 2', origin: 'agent', parentId: 'fg' })
    )
    await tick()
    expect(seen['t0']).toMatchObject({ skillId: 'mail', parentTaskId: 'fg' })
    finish['t0']()
    await tick()
    await tick()
    expect(seen['t1'].skillId).toBeUndefined()
    expect(seen['t1'].parentTaskId).toBe('fg')
  })
})
