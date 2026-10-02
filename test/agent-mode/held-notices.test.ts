// Notices held until the user's turn ends keep the usage scope they were raised in (a spoken
// reminder counts toward its automation even when it is said after the user's own turn).
import { describe, expect, it } from 'vitest'
import { HeldNotices } from '../../src/main/agent-mode/background/presence'
import { currentUsageScope, runInUsageScope } from '../../src/main/usage/scope'
import { reminderUsageScope } from '../../src/main/usage/task-scope'

describe('held notices', () => {
  it('replay each line in the scope it was raised in', () => {
    const held = new HeldNotices()
    runInUsageScope(reminderUsageScope('au_1'), () => held.push('Stretch your legs'))
    held.push('Background task done: x.')
    const heard: { text: string; automationId?: string; origin: string }[] = []
    const replays = held.drain()
    expect(held.drain()).toEqual([])
    for (const replay of replays)
      replay((text) => {
        const s = currentUsageScope()
        heard.push({ text, automationId: s.automationId, origin: s.origin })
      })
    expect(heard[0]).toMatchObject({ text: 'Stretch your legs', automationId: 'au_1' })
    expect(heard[0].origin).not.toBe('user-direct')
    expect(heard[1]).toMatchObject({ text: 'Background task done: x.', origin: 'system' })
  })
})
