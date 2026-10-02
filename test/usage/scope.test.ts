import { describe, expect, it } from 'vitest'
import {
  currentUsageScope,
  speechOrigin,
  withUsageFeature,
  withUsageScope
} from '../../src/main/usage/scope'

describe('usage scope', () => {
  it('is system outside any scope', () => {
    expect(currentUsageScope()).toEqual({ origin: 'system' })
  })

  it('keeps parent fields and moves the task id to parentTaskId', async () => {
    const seen = await withUsageScope({ origin: 'buddy', buddyId: 'b1', taskId: 't1' }, () =>
      withUsageScope({ origin: 'subagent', taskId: 't2' }, async () => {
        await new Promise((r) => setTimeout(r, 1))
        return withUsageFeature('research', () => currentUsageScope())
      })
    )
    expect(seen).toEqual({
      origin: 'subagent',
      buddyId: 'b1',
      taskId: 't2',
      parentTaskId: 't1',
      feature: 'research'
    })
  })

  it('does not leak out of the scope', () => {
    withUsageScope({ origin: 'agent', taskId: 'x' }, () => undefined)
    expect(currentUsageScope().origin).toBe('system')
  })
})

describe('cloud speech origin (review L2)', () => {
  it("is the user's for speech to text, the running scope's for a spoken reply", () => {
    expect(speechOrigin('stt')).toBe('user-direct')
    expect(speechOrigin('stt', true)).toBe('dictation')
    expect(speechOrigin('tts')).toBe('user-direct')
    expect(withUsageScope({ origin: 'buddy' }, () => speechOrigin('tts'))).toBe('buddy')
    expect(withUsageScope({ origin: 'buddy' }, () => speechOrigin('stt'))).toBe('user-direct')
  })
})
