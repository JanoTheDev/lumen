import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  nextRun,
  parseRoutineUtterance,
  parseTime,
  validSchedule
} from '../../src/main/routines/schedule'

// Local-time dates (the scheduler works in local time).
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

describe('nextRun', () => {
  it('daily: later today, else tomorrow', () => {
    const s = { kind: 'daily' as const, at: '09:00' }
    expect(nextRun(s, at(2026, 10, 1, 8, 0))).toBe(at(2026, 10, 1, 9, 0))
    expect(nextRun(s, at(2026, 10, 1, 9, 0))).toBe(at(2026, 10, 2, 9, 0))
    expect(nextRun(s, at(2026, 10, 1, 23, 0))).toBe(at(2026, 10, 2, 9, 0))
  })

  it('weekdays skip the weekend', () => {
    const s = { kind: 'daily' as const, at: '09:00', days: [1, 2, 3, 4, 5] }
    // 2026-10-02 is a Friday.
    expect(new Date(at(2026, 10, 2)).getDay()).toBe(5)
    expect(nextRun(s, at(2026, 10, 2, 10, 0))).toBe(at(2026, 10, 5, 9, 0))
  })

  it('every N minutes counts from the given time', () => {
    expect(nextRun({ kind: 'every', minutes: 30 }, 1000)).toBe(1000 + 30 * 60_000)
  })

  it('validates', () => {
    expect(validSchedule({ kind: 'every', minutes: 14 })).toBe(false)
    expect(validSchedule({ kind: 'every', minutes: 15 })).toBe(true)
    expect(validSchedule({ kind: 'daily', at: '24:00' })).toBe(false)
    expect(validSchedule({ kind: 'daily', at: '07:30', days: [7] })).toBe(false)
  })

  it('describes', () => {
    expect(describeSchedule({ kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] })).toBe(
      'every weekday at 09:00'
    )
    expect(describeSchedule({ kind: 'daily', at: '18:30' })).toBe('every day at 18:30')
    expect(describeSchedule({ kind: 'every', minutes: 120 })).toBe('every 2 hours')
    expect(describeSchedule({ kind: 'every', minutes: 45 })).toBe('every 45 minutes')
    expect(describeSchedule({ kind: 'daily', at: '10:00', days: [1] })).toBe(
      'every Monday at 10:00'
    )
  })
})

describe('parseTime', () => {
  it.each([
    ['9', undefined, '09:00'],
    ['9 am', undefined, '09:00'],
    ['9:30 pm', undefined, '21:30'],
    ['9.30', undefined, '09:30'],
    ['7', 'evening', '19:00'],
    ['12 am', undefined, '00:00'],
    ['noon', undefined, '12:00'],
    ['seven', undefined, '07:00'],
    ['6 p.m.', undefined, '18:00']
  ])('%s (%s) → %s', (raw, part, want) => {
    expect(parseTime(raw, part)).toBe(want)
  })

  it('rejects nonsense', () => {
    expect(parseTime('25')).toBeNull()
    expect(parseTime('13 pm')).toBeNull()
  })
})

describe('parseRoutineUtterance', () => {
  it('every weekday at 9 …', () => {
    const r = parseRoutineUtterance('Every weekday at 9 summarize the news on Hacker News')
    expect(r).toEqual({
      ok: true,
      schedule: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
      prompt: 'summarize the news on Hacker News',
      usedDefaultTime: false
    })
  })

  it('every N minutes / hours', () => {
    expect(parseRoutineUtterance('every 30 minutes check the price of the lamp')).toMatchObject({
      ok: true,
      schedule: { kind: 'every', minutes: 30 },
      prompt: 'check the price of the lamp'
    })
    expect(parseRoutineUtterance('every two hours, check my inbox for invoices')).toMatchObject({
      ok: true,
      schedule: { kind: 'every', minutes: 120 },
      prompt: 'check my inbox for invoices'
    })
    expect(parseRoutineUtterance('every hour check the server status page')).toMatchObject({
      schedule: { kind: 'every', minutes: 60 }
    })
  })

  it('too often is refused with a reason', () => {
    expect(parseRoutineUtterance('every 5 minutes check the lamp price')).toEqual({
      ok: false,
      reason: expect.stringMatching(/15 minutes/)
    })
  })

  it('days and parts of the day', () => {
    expect(parseRoutineUtterance('every monday and friday at 8:30 back up my notes')).toMatchObject(
      { schedule: { kind: 'daily', at: '08:30', days: [1, 5] } }
    )
    expect(parseRoutineUtterance('every evening at 7 summarize what I read today')).toMatchObject({
      schedule: { kind: 'daily', at: '19:00' }
    })
    expect(parseRoutineUtterance('every morning check the weather in Vienna')).toMatchObject({
      schedule: { kind: 'daily', at: '08:00' },
      usedDefaultTime: true
    })
  })

  it('create a routine … with the schedule at the end', () => {
    expect(
      parseRoutineUtterance('Create a routine to check the lamp price every day at 6 pm')
    ).toMatchObject({
      ok: true,
      schedule: { kind: 'daily', at: '18:00' },
      prompt: 'check the lamp price'
    })
    expect(parseRoutineUtterance('create a routine')).toMatchObject({ ok: false })
  })

  it('ordinary sentences are not routines', () => {
    for (const s of [
      'every day is a gift',
      'every 15 minutes my computer freezes',
      'every monday is awful',
      'how do I back up every day at 9',
      'what is the weather',
      'every day at 9 is when I wake up'
    ])
      expect(parseRoutineUtterance(s), s).toBeNull()
  })
})
