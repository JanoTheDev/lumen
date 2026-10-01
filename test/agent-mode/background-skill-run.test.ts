import { describe, expect, it } from 'vitest'
import { backgroundRunRecord } from '../../src/main/agent-mode/background/skills'

describe('background skill run history', () => {
  it('records the outcome of a finished task', () => {
    expect(backgroundRunRecord({ status: 'done', summary: 'Saved 3 rows.' }, 1000, 4500)).toEqual({
      at: 1000,
      ms: 3500,
      how: 'background',
      status: 'done',
      summary: 'Saved 3 rows.',
      actions: 0
    })
  })

  it('a thrown task is failed, or cancelled when its signal was aborted', () => {
    const err = new Error('E_DENIED: no network')
    expect(backgroundRunRecord({ error: err, cancelled: false }, 0, 10)).toMatchObject({
      status: 'failed',
      summary: 'E_DENIED: no network'
    })
    expect(backgroundRunRecord({ error: err, cancelled: true }, 0, 10)).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled.'
    })
  })
})
