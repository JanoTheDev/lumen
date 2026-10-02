// A buddy's monthly spend is the monthly limits' own number (usage review L6): an unpriced paid
// call counts at the fallback rate in both.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordCall, setLedgerDir } from '../../src/main/usage/ledger'
import {
  installUsageLimits,
  limitState,
  resetUsageLimits,
  setLimitsStatePath
} from '../../src/main/usage/limits'
import { ledgerSpend } from '../../src/main/buddies/spend'

let dir: string
const now = new Date(2026, 9, 10, 12)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-buddy-spend-'))
  setLedgerDir(dir)
  setLimitsStatePath(join(dir, 'limits-state.json'))
  installUsageLimits({
    limits: () => ({ automations: {} }),
    buddy: (id) => (id === 'inbox' ? { name: 'Inbox Buddy', perMonthUsd: 1 } : null),
    automationName: () => undefined,
    notify: () => {},
    warn: () => {},
    now: () => now
  })
})
afterEach(() => {
  resetUsageLimits()
  setLimitsStatePath(null)
  setLedgerDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('a buddy monthly spend', () => {
  it('matches the monthly limits, unpriced paid calls included', () => {
    const base = { provider: 'anthropic', in: 1000, out: 1000, origin: 'buddy', buddyId: 'inbox' }
    recordCall({ ...base, model: 'm', usd: 0.1, t: now.getTime() })
    // A paid model with no known price: $0 on the line, an estimate for the caps.
    recordCall({
      ...base,
      model: 'unknown-model',
      usd: 0,
      priced: false,
      est: 0.3,
      t: now.getTime()
    })
    const s = limitState({ kind: 'buddy', id: 'inbox' })
    expect(s.usd).toBeCloseTo(0.4)
    expect(ledgerSpend('inbox', now)).toEqual({ usd: s.usd, tokens: s.tokens })
    expect(ledgerSpend('inbox', now)?.tokens).toBe(4000)
  })
})
