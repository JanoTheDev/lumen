import { describe, expect, it } from 'vitest'
import { configPatchSchema, configV2Schema, DEFAULT_CONFIG_V2 } from '../../src/shared/config'
import { STAGE_BUDGETS_MS, toPerfTurn, totalBudgetMs, turnStages } from '../../src/shared/perf'

describe('perf stage budgets', () => {
  it('a spoken turn has speech, first reply and whole-turn stages', () => {
    expect(
      turnStages({
        mode: 'answer',
        outcome: 'done',
        speechToQueryMs: 600,
        firstByteMs: 800,
        totalMs: 2000
      })
    ).toEqual([
      { name: 'Speech to text', ms: 600, budgetMs: 400 },
      { name: 'First reply', ms: 800, budgetMs: 900 },
      { name: 'Whole turn', ms: 2600, budgetMs: 3000 }
    ])
  })

  it('a typed turn without a streamed reply has only the whole turn', () => {
    expect(turnStages({ mode: 'locate', outcome: 'failed', totalMs: 120 })).toEqual([
      { name: 'Whole turn', ms: 120, budgetMs: STAGE_BUDGETS_MS.total }
    ])
  })

  it('guide and action turns get the larger whole-turn budget', () => {
    expect(totalBudgetMs('action')).toBe(STAGE_BUDGETS_MS.totalWithSteps)
    expect(totalBudgetMs('guide')).toBe(STAGE_BUDGETS_MS.totalWithSteps)
    expect(totalBudgetMs('answer')).toBe(STAGE_BUDGETS_MS.total)
    expect(totalBudgetMs('unknown')).toBe(STAGE_BUDGETS_MS.total)
  })

  it('toPerfTurn carries mode, outcome and time', () => {
    const t = toPerfTurn({ mode: 'answer', outcome: 'cancelled', totalMs: 10 }, 42)
    expect(t).toMatchObject({ at: 42, mode: 'answer', outcome: 'cancelled' })
  })
})

describe('debug.perfOverlay', () => {
  it('defaults off, also for a config written before it existed', () => {
    expect(DEFAULT_CONFIG_V2.debug).toEqual({ perfOverlay: false })
    const old: Record<string, unknown> = { ...DEFAULT_CONFIG_V2 }
    delete old.debug
    expect(configV2Schema.parse(old).debug).toEqual({ perfOverlay: false })
  })

  it('a patch can turn it on; other keys are refused', () => {
    expect(configPatchSchema.safeParse({ debug: { perfOverlay: true } }).data).toEqual({
      debug: { perfOverlay: true }
    })
    expect(configPatchSchema.safeParse({ debug: { other: 1 } }).success).toBe(false)
  })
})
