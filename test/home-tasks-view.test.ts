import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@shared/types'
import { taskRow, taskRows } from '../src/renderer/src/panel/home/tasks-view'

const t = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 'bg_x0001',
  title: 'Compare laptops',
  prompt: 'compare laptops',
  origin: 'voice',
  phase: 'running',
  progress: [],
  counters: { modelCalls: 0, costUsd: 0, startedAt: 0 },
  ...over
})

describe('Home tasks view', () => {
  it('shows the latest progress line and cost while running', () => {
    const r = taskRow(
      t({
        progress: ['Reading a.com', 'Reading b.com'],
        counters: { modelCalls: 3, costUsd: 0.04, startedAt: 0 }
      })
    )
    expect(r.status).toBe('Reading b.com · $0.04')
    expect(r).toMatchObject({ canCancel: true, canRunAgain: false, canOpen: true })
  })

  it('offers answers for queued questions and run again for interrupted tasks', () => {
    const asking = taskRow(
      t({ phase: 'asking', question: { text: 'Which day?', choices: ['Fri'] } })
    )
    expect(asking.question).toEqual({ text: 'Which day?', choices: ['Fri'] })
    const stopped = taskRow(t({ phase: 'interrupted' }))
    expect(stopped).toMatchObject({
      canRunAgain: true,
      canCancel: false,
      status: 'Stopped when Lumen closed'
    })
    const done = taskRow(t({ phase: 'done', unseen: true, result: { summary: 'X1 wins.' } }))
    expect(done).toMatchObject({ status: 'X1 wins.', canOpen: true, unseen: true })
  })

  it('lists open tasks first and hides helper tasks', () => {
    const rows = taskRows([
      t({ id: 'bg_done01', phase: 'done', result: { summary: 'ok' } }),
      t({ id: 'bg_child1', parentId: 'bg_run001' }),
      t({ id: 'bg_run001' })
    ])
    expect(rows.map((r) => r.id)).toEqual(['bg_run001', 'bg_done01'])
  })
})
