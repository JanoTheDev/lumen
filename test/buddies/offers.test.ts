// "Want a buddy for this?" (08 T51): recurring asks only, a gap between the two asks, once per
// pattern, the off switch, keyed hashes only and nothing kept with memory off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BuddyOfferStore,
  OFFER_GAP_MS,
  OFFER_WINDOW_MS,
  isRecurringAsk,
  matchOffersSwitch
} from '../../src/main/buddies/offers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-buddy-offers-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 9, 1, 8)
const ASK = 'check my inbox for mail from my boss'

describe('isRecurringAsk', () => {
  it('knows recurring work', () => {
    expect(isRecurringAsk('check my inbox for new mail')).toBe(true)
    expect(isRecurringAsk("what's new in tech news")).toBe(true)
    expect(isRecurringAsk('summarize my unread mail again')).toBe(true)
    expect(isRecurringAsk('open notepad')).toBe(false)
    expect(isRecurringAsk('write an email to Sam about the party')).toBe(false)
  })
})

describe('BuddyOfferStore', () => {
  it('offers after a second alike ask past the gap, once', () => {
    const s = new BuddyOfferStore(null)
    expect(s.consider(ASK, { now: T0 })).toBeNull()
    // A quick retry is not "twice".
    expect(s.consider(ASK, { now: T0 + 60_000 })).toBeNull()
    const v = s.consider(ASK, { now: T0 + OFFER_GAP_MS + 1 })
    expect(v?.prompt).toBe(ASK)
    s.answered(v!.words, 'offered', T0)
    expect(s.consider(ASK, { now: T0 + 2 * OFFER_GAP_MS })).toBeNull()
  })

  it('ignores old asks, other work and covered asks', () => {
    const s = new BuddyOfferStore(null)
    s.consider(ASK, { now: T0 })
    expect(s.consider(ASK, { now: T0 + OFFER_WINDOW_MS + 1 })).toBeNull()
    const t = new BuddyOfferStore(null)
    t.consider(ASK, { now: T0 })
    expect(
      t.consider('check the price of the sony headphones', { now: T0 + OFFER_GAP_MS + 1 })
    ).toBeNull()
    expect(t.consider(ASK, { now: T0 + OFFER_GAP_MS + 1, covered: true })).toBeNull()
  })

  it('the off switch stops offers', () => {
    const s = new BuddyOfferStore(null)
    s.consider(ASK, { now: T0 })
    s.setOff(true)
    expect(s.consider(ASK, { now: T0 + OFFER_GAP_MS + 1 })).toBeNull()
  })

  it('keeps keyed hashes only, and nothing with memory off', () => {
    const file = join(dir, 'buddy-offers.json')
    const s = new BuddyOfferStore(file, { key: Buffer.alloc(32, 7) })
    s.consider(ASK, { now: T0 })
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/inbox|boss/)
    const again = new BuddyOfferStore(file, { key: Buffer.alloc(32, 7) })
    expect(again.consider(ASK, { now: T0 + OFFER_GAP_MS + 1 })).not.toBeNull()

    const off = join(dir, 'off.json')
    const p = new BuddyOfferStore(off, { canRecord: () => false })
    expect(p.consider(ASK, { now: T0 })).toBeNull()
    expect(existsSync(off)).toBe(false)
  })
})

describe('matchOffersSwitch', () => {
  it('reads both ways', () => {
    expect(matchOffersSwitch('Stop offering buddies.')).toBe('off')
    expect(matchOffersSwitch("don't suggest buddies")).toBeNull()
    expect(matchOffersSwitch('start offering buddies again')).toBe('on')
  })
})
