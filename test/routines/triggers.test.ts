import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  describeAutomation,
  describeTrigger,
  nextFire,
  ordinal,
  validTrigger
} from '../../src/main/routines/triggers'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

describe('nextFire', () => {
  it('daily and plain every (as routines)', () => {
    expect(nextFire({ kind: 'daily', at: '09:00' }, at(2026, 10, 1, 8))).toBe(at(2026, 10, 1, 9))
    expect(nextFire({ kind: 'every', minutes: 30 }, 1000)).toBe(1000 + 30 * 60_000)
  })

  it('every hour between 9 and 17: on the hour inside the window, else the next window', () => {
    const t = { kind: 'every' as const, minutes: 60, from: '09:00', to: '17:00' }
    expect(nextFire(t, at(2026, 10, 1, 7))).toBe(at(2026, 10, 1, 9))
    expect(nextFire(t, at(2026, 10, 1, 9, 0))).toBe(at(2026, 10, 1, 10))
    expect(nextFire(t, at(2026, 10, 1, 13, 20))).toBe(at(2026, 10, 1, 14))
    expect(nextFire(t, at(2026, 10, 1, 16, 59))).toBe(at(2026, 10, 1, 17))
    expect(nextFire(t, at(2026, 10, 1, 17, 0))).toBe(at(2026, 10, 2, 9))
  })

  it('a window on weekdays skips the weekend', () => {
    const t = {
      kind: 'every' as const,
      minutes: 30,
      from: '09:00',
      to: '10:00',
      days: [1, 2, 3, 4, 5]
    }
    // 2026-10-02 is a Friday.
    expect(nextFire(t, at(2026, 10, 2, 10, 0))).toBe(at(2026, 10, 5, 9))
  })

  it('monthly: the given day, or the last day of a short month', () => {
    expect(nextFire({ kind: 'monthly', day: 1, at: '09:00' }, at(2026, 10, 1, 8))).toBe(
      at(2026, 10, 1, 9)
    )
    expect(nextFire({ kind: 'monthly', day: 1, at: '09:00' }, at(2026, 10, 1, 10))).toBe(
      at(2026, 11, 1, 9)
    )
    expect(nextFire({ kind: 'monthly', day: 31, at: '12:00' }, at(2026, 11, 1))).toBe(
      at(2026, 11, 30, 12)
    )
    expect(nextFire({ kind: 'monthly', day: 30, at: '12:00' }, at(2027, 2, 1))).toBe(
      at(2027, 2, 28, 12)
    )
  })

  it('once: its time while ahead, then never', () => {
    expect(nextFire({ kind: 'once', at: 5000 }, 1000)).toBe(5000)
    expect(nextFire({ kind: 'once', at: 5000 }, 5000)).toBeNull()
    expect(nextFire({ kind: 'startup' }, 0)).toBeNull()
    expect(nextFire({ kind: 'app', app: 'Excel', on: 'open' }, 0)).toBeNull()
  })
})

describe('nextFire across DST (Europe/Amsterdam)', () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/Amsterdam'
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it('daily 09:00 stays at 09:00 wall clock over the spring and autumn change', () => {
    // 2026-03-29 02:00 → 03:00 (spring forward); 2026-10-25 03:00 → 02:00 (fall back).
    const d = { kind: 'daily' as const, at: '09:00' }
    const spring = nextFire(d, at(2026, 3, 28, 10))!
    expect(new Date(spring).getHours()).toBe(9)
    expect(new Date(spring).getDate()).toBe(29)
    // 23 hours apart in absolute time.
    expect(spring - at(2026, 3, 28, 9)).toBe(23 * 3600_000)
    const fall = nextFire(d, at(2026, 10, 24, 10))!
    expect(new Date(fall).getHours()).toBe(9)
    expect(fall - at(2026, 10, 24, 9)).toBe(25 * 3600_000)
  })

  it('a window and a monthly run keep their wall-clock times', () => {
    const w = { kind: 'every' as const, minutes: 60, from: '01:00', to: '05:00' }
    const runs: number[] = []
    let t = at(2026, 3, 29, 0, 30)
    for (let i = 0; i < 4; i++) {
      t = nextFire(w, t)!
      runs.push(new Date(t).getHours())
    }
    // 02:00 does not exist that night: setHours lands on 03:00, the hours stay on the clock.
    expect(runs[0]).toBe(1)
    expect(runs.every((h) => h >= 1 && h <= 5)).toBe(true)
    const m = nextFire({ kind: 'monthly', day: 25, at: '09:00' }, at(2026, 10, 1))!
    expect(new Date(m).getHours()).toBe(9)
    expect(new Date(m).getDate()).toBe(25)
  })
})

describe('validTrigger / describe', () => {
  it('validates', () => {
    expect(validTrigger({ kind: 'every', minutes: 60, from: '09:00', to: '17:00' })).toBe(true)
    expect(validTrigger({ kind: 'every', minutes: 60, from: '17:00', to: '09:00' })).toBe(false)
    expect(validTrigger({ kind: 'every', minutes: 60, from: '09:00' })).toBe(false)
    expect(validTrigger({ kind: 'every', minutes: 10 })).toBe(false)
    expect(validTrigger({ kind: 'monthly', day: 32, at: '09:00' })).toBe(false)
    expect(validTrigger({ kind: 'idle', minutes: 0, on: 'idle' })).toBe(false)
    expect(validTrigger({ kind: 'file', folder: 'C:\\x', on: 'added', pattern: '*.pdf' })).toBe(
      true
    )
    expect(validTrigger({ kind: 'file', folder: 'C:\\x', on: 'added', pattern: '../x' })).toBe(
      false
    )
  })

  it('describes', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(22)).toBe('22nd')
    expect(describeTrigger({ kind: 'every', minutes: 60, from: '09:00', to: '17:00' })).toBe(
      'every hour between 09:00 and 17:00'
    )
    expect(describeTrigger({ kind: 'monthly', day: 1, at: '09:00' })).toBe(
      'every month on the 1st at 09:00'
    )
    expect(describeTrigger({ kind: 'once', at: at(2026, 10, 2, 8) })).toBe(
      'once, on Friday 2 Oct at 08:00'
    )
    expect(
      describeTrigger({
        kind: 'file',
        folder: 'C:\\Users\\a\\Downloads',
        on: 'added',
        pattern: '*.pdf'
      })
    ).toBe('when a PDF file is added to Downloads')
    expect(describeTrigger({ kind: 'idle', minutes: 10, on: 'back' })).toBe(
      'when you are back after 10 minutes away'
    )
    expect(
      describeAutomation(
        { kind: 'app', app: 'Excel', on: 'open' },
        { kind: 'remind', say: 'Save a copy.' }
      )
    ).toBe('When Excel opens, remind you: “Save a copy.”')
  })
})
