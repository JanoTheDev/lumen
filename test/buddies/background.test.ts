// Buddy tasks in the background manager and task store (08 T50): origin buddy and the buddy id
// survive a start, Run again and a reload from disk.
import { describe, expect, it } from 'vitest'
import { BackgroundManager } from '../../src/main/agent-mode/background/manager'
import { parseTask } from '../../src/main/agent-mode/background/store'

describe('buddy tasks', () => {
  it('keep origin buddy and buddyId through Run again', async () => {
    let n = 0
    const m = new BackgroundManager({
      max: () => 2,
      run: async () => ({ status: 'done', summary: 'ok' }),
      emit: () => {},
      now: () => 1000,
      newId: () => `bg_test${++n}`
    })
    const t = m.start({
      prompt: 'You are Inbox Buddy',
      userText: 'Sum up mail',
      origin: 'buddy',
      buddyId: 'inbox-buddy'
    })
    expect(t).toMatchObject({ origin: 'buddy', buddyId: 'inbox-buddy', userText: 'Sum up mail' })
    await m.wait(t.id)
    const again = m.runAgain(t.id)
    expect(again).toMatchObject({ origin: 'buddy', buddyId: 'inbox-buddy' })
  })

  it('load from the task store', () => {
    const raw = {
      id: 'bg_abcd1234',
      title: 'Inbox Buddy: run now',
      prompt: 'p',
      origin: 'buddy',
      buddyId: 'inbox-buddy',
      phase: 'done',
      progress: [],
      counters: { modelCalls: 1, costUsd: 0.01, startedAt: 5 }
    }
    expect(parseTask(raw)).toMatchObject({ origin: 'buddy', buddyId: 'inbox-buddy' })
    expect(parseTask({ ...raw, buddyId: 7 })).not.toHaveProperty('buddyId')
    expect(parseTask({ ...raw, origin: 'stranger' })).toBeNull()
  })
})
