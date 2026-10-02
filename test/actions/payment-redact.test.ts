import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))

import { findPrice, PRICE_NOT_READ, withCheckoutPrice } from '../../src/main/actions/checkout-price'
import { hasCardNumber, redactForLog, redactForModel } from '../../src/main/actions/redact'
import { luhn } from '../../src/main/ai/memory/sensitive'
import type { Decision } from '../../src/main/actions/safety'

describe('luhn', () => {
  it.each(['4242424242424242', '4111111111111111', '378282246310005', '5555555555554444'])(
    '%s passes',
    (n) => expect(luhn(n)).toBe(true)
  )
  it.each(['4242424242424241', '1234567890123', '12345'])('%s fails', (n) =>
    expect(luhn(n)).toBe(false)
  )
})

describe('hasCardNumber', () => {
  it('finds grouped and plain card numbers, also with digits after them', () => {
    expect(hasCardNumber('4242 4242 4242 4242')).toBe(true)
    expect(hasCardNumber('card 4242424242424242 123')).toBe(true)
    expect(hasCardNumber('4242-4242-4242-4242 12/27 123')).toBe(true)
    expect(hasCardNumber('order 4242 4242 4242 4241')).toBe(false)
    expect(hasCardNumber('call 0612345678')).toBe(false)
  })

  it.each([
    '4242.4242.4242.4242',
    '4242_4242_4242_4242',
    '4242  4242  4242  4242',
    '４２４２'.repeat(4)
  ])('finds %s (dots, underscores, double spaces, full-width digits; review M2)', (t) => {
    expect(hasCardNumber(t)).toBe(true)
  })
})

describe('payment redaction', () => {
  it.each([redactForLog, redactForModel])('redacts cards, CVCs and IBANs (%#)', (fn) => {
    const out = fn('Card 4242 4242 4242 4242 12/27 123, CVC: 456, IBAN NL91ABNA0417164300')
    expect(out).not.toContain('4242')
    expect(out).not.toContain('456')
    expect(out).not.toContain('NL91ABNA0417164300')
    expect(out).toContain('[redacted:card]')
    expect(out).toContain('[redacted:cvc]')
    expect(out).toContain('[redacted:iban]')
    expect(out).toContain('12/27')
  })

  it.each([
    'CVV 123',
    'security code: 1234',
    'Beveiligingscode 321',
    'Prüfnummer: 987',
    'cryptogramme visuel 654',
    'código de seguridad 852'
  ])('redacts the code in %s', (text) => {
    // "security code 1234" is also the detector's one-time code: redacted either way.
    expect(redactForLog(text)).toMatch(/\[redacted:(cvc|one-time-code)\]$/)
  })

  it('leaves plain numbers and dates after other text alone', () => {
    expect(redactForLog('3 rooms, 120 EUR, 2026-10-02')).toBe('3 rooms, 120 EUR, 2026-10-02')
  })

  it('does not take a date on the next line for a CVC', () => {
    expect(redactForLog('4242424242424242\n2026-10-02')).toBe('[redacted:card]\n2026-10-02')
  })
})

describe('findPrice', () => {
  it('prefers the total line', () => {
    const page = 'Room €120 per night\n2 nights\nTaxes €12.50\nTotal €252.50\nBook now'
    expect(findPrice(page, 'book now')).toBe('€252.50')
  })

  it('finds a total whose label is on the line above (OCR)', () => {
    expect(findPrice('Te betalen\n€ 1.234,56\nNu betalen', 'nu betalen')).toBe('€ 1.234,56')
  })

  it('takes the amount nearest the button without a total', () => {
    const page = 'Breakfast $15\nDeluxe room $340.00 Reserve\nSuite $600'
    expect(findPrice(page, 'reserve')).toBe('$340.00')
  })

  it('reads suffix currencies and codes', () => {
    expect(findPrice('Gesamtbetrag 89,90 €')).toBe('89,90 €')
    expect(findPrice('Price: EUR 1200')).toBe('EUR 1200')
  })

  it('normalizes non-breaking spaces', () => {
    expect(findPrice('Total 1 234,56 €')).toBe('1 234,56 €')
  })

  it('returns null without an amount', () => {
    expect(findPrice('Book now')).toBeNull()
  })
})

describe('withCheckoutPrice', () => {
  const d: Decision = {
    risk: 'high',
    reason: 'books or pays: “book now”',
    needsConfirm: true,
    checkout: 'book now'
  }

  it('adds the price read from the page now', async () => {
    const r = await withCheckoutPrice(d, async () => 'Total: £99.00\nBook now')
    expect(r.reason).toBe('books or pays: “book now”; price on the page now: £99.00')
  })

  it('says it could not read the price', async () => {
    expect((await withCheckoutPrice(d, async () => '')).reason).toContain(PRICE_NOT_READ)
    expect(
      (
        await withCheckoutPrice(d, async () => {
          throw new Error('timeout')
        })
      ).reason
    ).toContain(PRICE_NOT_READ)
  })

  it('leaves other decisions alone without reading', async () => {
    const read = vi.fn(async () => 'x')
    const other: Decision = { risk: 'low', reason: 'click', needsConfirm: false }
    expect(await withCheckoutPrice(other, read)).toBe(other)
    expect(read).not.toHaveBeenCalled()
  })

  it('without an agent the price is not read', async () => {
    expect((await withCheckoutPrice(d)).reason).toContain(PRICE_NOT_READ)
  })
})
