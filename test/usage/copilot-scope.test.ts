import { describe, expect, it } from 'vitest'
import { copilotScope } from '../../src/main/claude-code/copilot-scope'
import { currentUsageScope, withUsageScope } from '../../src/main/usage/scope'

describe('Claude Code copilot usage scope (review L1)', () => {
  it("records autopilot calls as Lumen's copilot spend, not the turn that started them", async () => {
    const seen = await withUsageScope(
      { origin: 'user-direct', feature: 'answer', taskId: 't_1', buddyId: 'b' },
      () => copilotScope('autopilot', async () => ({ ...currentUsageScope() }))
    )
    expect(seen).toEqual({ origin: 'claude-code-copilot', feature: 'autopilot' })
  })

  it("carries the Claude session and its task, so the session's cost includes them (s6 L4)", async () => {
    const seen = await withUsageScope({ origin: 'user-direct', taskId: 't_1' }, () =>
      copilotScope('autopilot', async () => ({ ...currentUsageScope() }), {
        ccSession: 'cc_1',
        taskId: 'bg_1'
      })
    )
    expect(seen).toEqual({
      origin: 'claude-code-copilot',
      feature: 'autopilot',
      ccSession: 'cc_1',
      taskId: 'bg_1'
    })
  })
})
