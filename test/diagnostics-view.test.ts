import { describe, expect, it } from 'vitest'
import { stageBar, turnSummary } from '../src/renderer/src/panel/settings/sections/diagnostics-view'

describe('diagnostics stage bars', () => {
  it('within budget: partial fill, plain text', () => {
    expect(stageBar({ name: 'First reply', ms: 450, budgetMs: 900 })).toEqual({
      name: 'First reply',
      fill: 0.5,
      over: false,
      text: '450 ms of 900 ms'
    })
  })

  it('over budget: full bar, says by how much', () => {
    expect(stageBar({ name: 'Whole turn', ms: 4240.4, budgetMs: 3000 })).toEqual({
      name: 'Whole turn',
      fill: 1,
      over: true,
      text: '4,240 ms of 3,000 ms, 1,240 ms over'
    })
  })

  it('exactly on budget is not over', () => {
    expect(stageBar({ name: 'x', ms: 400, budgetMs: 400 }).over).toBe(false)
  })

  it('summary counts the stages over budget', () => {
    const turn = {
      at: 0,
      mode: 'answer',
      outcome: 'done' as const,
      stages: [
        { name: 'Speech to text', ms: 600, budgetMs: 400 },
        { name: 'Whole turn', ms: 900, budgetMs: 3000 }
      ]
    }
    expect(turnSummary(turn, () => '14:05')).toBe(
      'Last turn (answer) finished at 14:05 · 1 of 2 stages over budget'
    )
    expect(turnSummary({ ...turn, stages: [turn.stages[1]] }, () => '14:05')).toBe(
      'Last turn (answer) finished at 14:05 · all within budget'
    )
  })
})
