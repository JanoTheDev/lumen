import { describe, it, expect } from 'vitest'
import { usageScopeForTask } from '../../src/main/usage/task-scope'
import { readEvent } from '../../src/main/claude-code/events'

describe('background task usage scope', () => {
  it('maps automations, buddies, skills and helpers', () => {
    expect(usageScopeForTask({ id: 'a', origin: 'routine', routineId: 'r1' })).toEqual({
      origin: 'automation',
      feature: 'agent-step',
      taskId: 'a',
      automationId: 'r1'
    })
    expect(usageScopeForTask({ id: 'b', origin: 'buddy', buddyId: 'bd' })).toMatchObject({
      origin: 'buddy',
      buddyId: 'bd'
    })
    expect(
      usageScopeForTask({ id: 'c', origin: 'agent', parentId: 'p', skill: 'mail' })
    ).toMatchObject({ origin: 'background', parentTaskId: 'p', skillId: 'mail' })
  })
})

describe('Claude Code result usage', () => {
  it('reads tokens and the model from a result event', () => {
    const fx = readEvent({
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.12,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40
      },
      modelUsage: { 'claude-sonnet-5-5': {} }
    })
    expect(fx.turnEnded?.usage).toEqual({
      model: 'claude-sonnet-5-5',
      in: 10,
      out: 20,
      cacheRead: 300,
      cacheWrite: 40
    })
  })
})
