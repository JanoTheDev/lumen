import { describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationAction } from '@shared/automations'
import { limitSkip } from '../../src/main/routines/limit-skip'

const auto = (action: AutomationAction): Automation => ({
  id: 'au_1',
  name: 'Morning',
  trigger: { kind: 'daily', at: '08:00' },
  action,
  preApproved: [],
  enabled: true,
  failures: 0,
  createdAt: 0
})

const paused = {
  ok: false as const,
  reason: 'Paused: monthly limit.',
  scope: { kind: 'overall' as const }
}

describe('limitSkip', () => {
  it('skips a capped automation run instead of failing it', () => {
    const check = vi.fn(() => paused)
    expect(limitSkip(auto({ kind: 'task', prompt: 'x' } as AutomationAction), check)).toEqual({
      result: 'skipped',
      summary: 'Paused: monthly limit.'
    })
    expect(check).toHaveBeenCalledWith({ automationId: 'au_1' })
  })

  it('passes the buddy id for a buddy action', () => {
    const check = vi.fn(() => ({ ok: true as const }))
    expect(limitSkip(auto({ kind: 'buddy', buddyId: 'inbox-buddy' }), check)).toBeNull()
    expect(check).toHaveBeenCalledWith({ automationId: 'au_1', buddyId: 'inbox-buddy' })
  })

  it('never blocks a reminder', () => {
    const check = vi.fn(() => paused)
    expect(limitSkip(auto({ kind: 'remind', say: 'stretch' }), check)).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })
})
