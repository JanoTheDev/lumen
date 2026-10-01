import { describe, expect, it } from 'vitest'
import {
  MIN_EF,
  START_EF,
  addDays,
  isCard,
  isDue,
  localDay,
  runQuality,
  sm2,
  type SrsCard
} from '../../src/main/teach/srs'
import type { StepStats } from '../../src/main/teach/state'

const NOW = new Date(2026, 9, 1, 10).getTime()
const DAY = 24 * 60 * 60 * 1000

const st = (p: Partial<StepStats> = {}): StepStats => ({
  attempts: 0,
  hints: 0,
  skipped: false,
  doItForMe: false,
  ...p
})

describe('runQuality', () => {
  it('5 with no hints, 4 for one or two, 3 for more, 2 for do-it or skip', () => {
    expect(runQuality({ a: st(), b: st() })).toBe(5)
    expect(runQuality({ a: st({ hints: 1 }), b: st({ hints: 1 }) })).toBe(4)
    expect(runQuality({ a: st({ hints: 2 }), b: st({ hints: 1 }) })).toBe(3)
    expect(runQuality({ a: st({ doItForMe: true }) })).toBe(2)
    expect(runQuality({ a: st({ skipped: true }) })).toBe(2)
  })
})

describe('SM-2', () => {
  it('a new card starts at EF 2.5 and is due the next day', () => {
    const c = sm2(undefined, 5, NOW)
    expect(c).toMatchObject({ reps: 1, interval: 1, due: '2026-10-02', last: NOW })
    expect(c.ef).toBeCloseTo(START_EF + 0.1)
  })

  it('perfect answers: intervals 1, 6, then interval × EF', () => {
    let c: SrsCard | undefined
    const intervals: number[] = []
    let t = NOW
    for (let i = 0; i < 5; i++) {
      c = sm2(c, 5, t)
      intervals.push(c.interval)
      t += c.interval * DAY
    }
    // EF 2.6, 2.7, 2.8, 2.9, 3.0 → 6 × 2.7 = 16, 16 × 2.8 = 45, 45 × 2.9 = 131
    expect(intervals).toEqual([1, 6, 16, 45, 131])
    expect(c!.ef).toBeCloseTo(3.0)
  })

  it('quality 3 keeps reviewing but lowers EF', () => {
    const c1 = sm2(undefined, 3, NOW)
    expect(c1.ef).toBeCloseTo(2.36)
    const c2 = sm2(c1, 3, NOW)
    expect(c2.interval).toBe(6)
    const c3 = sm2(c2, 3, NOW)
    expect(c3.interval).toBe(Math.round(6 * c2.ef))
  })

  it('quality 4 leaves EF unchanged', () => {
    expect(sm2(undefined, 4, NOW).ef).toBeCloseTo(2.5)
  })

  it('did-it-for-me (2) restarts the card, EF kept', () => {
    let c = sm2(undefined, 5, NOW)
    c = sm2(c, 5, NOW)
    c = sm2(c, 5, NOW)
    expect(c.interval).toBe(16)
    const failed = sm2(c, 2, NOW)
    expect(failed).toMatchObject({ reps: 0, interval: 1, due: '2026-10-02' })
    expect(failed.ef).toBe(c.ef)
  })

  it('EF never drops below 1.3', () => {
    let c: SrsCard | undefined
    for (let i = 0; i < 20; i++) c = sm2(c, 3, NOW)
    expect(c!.ef).toBe(MIN_EF)
  })
})

describe('days', () => {
  it('local days and adding across month ends and DST', () => {
    expect(localDay(NOW)).toBe('2026-10-01')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('2026-12-31', 6)).toBe('2027-01-06')
  })

  it('a card is due on and after its day', () => {
    const c = sm2(undefined, 5, NOW)
    expect(isDue(c, '2026-10-01')).toBe(false)
    expect(isDue(c, '2026-10-02')).toBe(true)
    expect(isDue(c, '2026-11-01')).toBe(true)
  })

  it('isCard checks the shape', () => {
    expect(isCard(sm2(undefined, 5, NOW))).toBe(true)
    expect(isCard({ ef: 2.5, interval: 1, reps: 0, due: 'tomorrow' })).toBe(false)
    expect(isCard(null)).toBe(false)
  })
})
