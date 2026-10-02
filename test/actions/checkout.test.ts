import { describe, it, expect } from 'vitest'
import {
  checkoutName,
  isPaymentFieldName,
  isPersonalFieldName,
  riskyName
} from '../../src/main/actions/risk-names'
import { evaluate, type PolicyCtx } from '../../src/main/actions/safety'

const agent: PolicyCtx = { origin: 'agent' }
const browser = { title: 'Checkout - Microsoft Edge', process: 'msedge.exe' }
const field = (name: string, extra: Record<string, unknown> = {}): PolicyCtx => ({
  origin: 'agent',
  activeWindow: { ...browser, focusKnown: true, focusName: name, focusRole: 'edit', ...extra }
})

describe('checkoutName', () => {
  it.each([
    ['Book', 'book'],
    ['Book now', 'book now'],
    ['Reserve', 'reserve'],
    ['Pay €120.00', 'pay'],
    ['Pay now', 'pay now'],
    ['Confirm booking', 'confirm booking'],
    ['Complete booking', 'complete booking'],
    ['Place order', 'place order'],
    ['Buy now', 'buy now'],
    ['Confirm and pay', 'confirm and pay'],
    ['Checkout', 'checkout'],
    ['Proceed to checkout', 'proceed to checkout'],
    ['Nu boeken', 'nu boeken'],
    ['Reserveren', 'reserveren'],
    ['Afrekenen', 'afrekenen'],
    ['Bestelling plaatsen', 'bestelling plaatsen'],
    ['Jetzt buchen', 'jetzt buchen'],
    ['Zahlungspflichtig bestellen', 'zahlungspflichtig bestellen'],
    ['Buchung bestätigen', 'buchung bestätigen'],
    ['Réserver', 'réserver'],
    ['Confirmer et payer', 'confirmer et payer'],
    ['Passer la commande', 'passer la commande'],
    ['Reservar ahora', 'reservar ahora'],
    ['Finalizar compra', 'finalizar compra'],
    ['→ Pay', 'pay']
  ])('%s → %s', (name, word) => {
    expect(checkoutName(name)).toBe(word)
  })

  it.each([
    ['Place your order', 'place order'],
    ['Complete order', 'complete order'],
    ['Order now', 'order now'],
    ['Confirm and book', 'confirm and book'],
    ['Confirm & pay', 'confirm and pay'],
    ['Confirm my booking', 'confirm booking'],
    ['Continue to payment', 'continue to payment'],
    ['Make payment', 'make payment'],
    ['Submit payment', 'submit payment'],
    ['Kostenpflichtig bestellen', 'kostenpflichtig bestellen'],
    ['Jetzt zahlen', 'jetzt zahlen'],
    ['Valider et payer', 'valider et payer'],
    ['Confirmer & payer', 'confirmer et payer'],
    ['Paga ora', 'paga ora'],
    ['Finalizar pedido', 'finalizar pedido']
  ])('final button %s → %s (review M1)', (name, word) => {
    expect(checkoutName(name)).toBe(word)
  })

  it.each([
    ['zero-width space', 'P​ay now'],
    ['soft hyphen', 'Pa­y now'],
    ['Cyrillic а', 'Pаy now'],
    ['Greek Ρ and Cyrillic у', 'Ρaу now'],
    ['full-width letters', 'Ｐａｙ now']
  ])('a disguised "Pay now" (%s) is still caught', (_label, name) => {
    expect(checkoutName(name)).toBe('pay now')
  })

  it('the same folding hardens the send / delete names', () => {
    expect(riskyName('S​end')).toBe('send')
    expect(riskyName('Dеlete')).toBe('delete')
  })

  it.each([
    'Address book',
    'Booking.com',
    'Facebook',
    'Books',
    'Payment methods',
    'Repay',
    'Notebook'
  ])('leaves %s alone', (name) => {
    expect(checkoutName(name)).toBeNull()
  })
})

describe('payment and personal field names', () => {
  it.each([
    'Card number',
    'Credit card number',
    'Cardholder name',
    'Name on card',
    'Expiry date',
    'MM/YY',
    'CVC',
    'CVV',
    'Security code',
    'IBAN',
    'Account number',
    'cc-number',
    'Kaartnummer',
    'Vervaldatum',
    'Kartennummer',
    'Prüfnummer',
    'Numéro de carte',
    'Cryptogramme visuel',
    'Número de tarjeta',
    'Código de seguridad'
  ])('payment: %s', (name) => {
    expect(isPaymentFieldName(name)).toBe(true)
  })

  it.each([
    'MM / YY',
    'MM/YYYY',
    'Expires',
    'Expiry',
    'Valid thru',
    '1234 1234 1234 1234',
    '•••• •••• •••• 4242',
    'Numero carta',
    'Codice di sicurezza',
    'Número do cartão',
    'Numer karty'
  ])('payment by mask, placeholder or it/pt/pl name: %s (review M2)', (name) => {
    expect(isPaymentFieldName(name)).toBe(true)
  })

  it.each(['Search', 'Message', 'Promo code', 'Number of guests', 'Phone', '+31 6 1234 5678'])(
    'not payment: %s',
    (name) => {
      expect(isPaymentFieldName(name)).toBe(false)
    }
  )

  it.each([
    'First name',
    'Last name',
    'Name *',
    'Your name (required)',
    'Email address',
    'Phone number',
    'Billing address',
    'Address',
    'Postcode',
    'Voornaam',
    'Achternaam',
    'Telefoonnummer',
    'Vorname',
    'Postleitzahl',
    'Prénom',
    'Code postal',
    'Apellidos',
    'Correo electrónico'
  ])('personal: %s', (name) => {
    expect(isPersonalFieldName(name)).toBe(true)
  })

  it.each([
    'Guest name',
    'Passenger name',
    'Lead traveller',
    'Vollständiger Name',
    'Nome',
    'Nome e cognome',
    'Cognome',
    'Sobrenome'
  ])('personal: %s (review L1)', (name) => {
    expect(isPersonalFieldName(name)).toBe(true)
  })

  it.each(['Event name', 'Company name', 'Display name', 'Folder name', 'User name'])(
    'not personal: %s (review L1)',
    (name) => {
      expect(isPersonalFieldName(name)).toBe(false)
    }
  )

  it.each([
    'File name',
    'Address and search bar',
    'Search email',
    'Subject',
    'Message',
    'Username'
  ])('not personal: %s', (name) => {
    expect(isPersonalFieldName(name)).toBe(false)
  })
})

describe('checkout guard', () => {
  it.each([
    'Book now',
    'Reserve',
    'Pay now',
    'Confirm booking',
    'Place order',
    'Buy now',
    'Nu betalen'
  ])('an agent click on %s is high, confirms and is never grantable', (name) => {
    const d = evaluate({ type: 'click_element', elementName: name }, agent)
    expect(d.risk).toBe('high')
    expect(d.needsConfirm).toBe(true)
    expect(d.grantScope).toBeUndefined()
    expect(d.checkout).toBeTruthy()
    expect(d.reason).toMatch(/books or pays/)
  })

  it('confirms even in never mode and with every grant', () => {
    const d = evaluate(
      { type: 'uia_act', action: 'invoke', elementName: 'Complete booking' },
      { ...agent, confirmMode: 'never', grants: { has: () => true } }
    )
    expect(d.needsConfirm).toBe(true)
    expect(d.checkout).toBe('complete booking')
  })

  it('Enter on a focused Book button is a checkout', () => {
    const d = evaluate(
      { type: 'hotkey', keys: ['Enter'] },
      { ...agent, activeWindow: { ...browser, focusName: 'Book', focusRole: 'button' } }
    )
    expect(d.risk).toBe('high')
    expect(d.checkout).toBe('book')
  })

  it('a routine is guarded too', () => {
    expect(
      evaluate({ type: 'click_element', elementName: 'Reserve' }, { origin: 'routine' }).checkout
    ).toBe('reserve')
  })

  it('user-direct clicks keep the older rules (no checkout flag)', () => {
    const d = evaluate(
      { type: 'click_element', elementName: 'Book now' },
      { origin: 'user-direct' }
    )
    expect(d.checkout).toBeUndefined()
    expect(d.risk).toBe('low')
  })
})

describe('payment fields', () => {
  it.each(['Card number', 'CVC', 'IBAN', 'Kaartnummer', 'Expiry date'])(
    'agent typing into %s is blocked',
    (name) => {
      const d = evaluate({ type: 'type', text: '12' }, field(name))
      expect(d.risk).toBe('blocked')
      expect(d.reason).toMatch(/payment field/)
    }
  )

  it('set_value into a payment field is blocked', () => {
    const d = evaluate(
      { type: 'uia_act', action: 'set_value', value: '123', elementName: 'Security code' },
      agent
    )
    expect(d.risk).toBe('blocked')
  })

  it.each([
    '4242 4242 4242 4242',
    '4242424242424242',
    '4242-4242-4242-4242 12/27 123',
    '378282246310005'
  ])('a Luhn-valid number %s is blocked anywhere for an agent', (text) => {
    const d = evaluate({ type: 'type', text }, field('Message'))
    expect(d.risk).toBe('blocked')
    expect(d.reason).toMatch(/card number/)
  })

  it('an IMEI passes Luhn but is no card: it asks instead of blocking (review M5)', () => {
    const d = evaluate({ type: 'type', text: '490154203237518' }, field('IMEI'))
    expect(d.risk).toBe('high')
    expect(d.needsConfirm).toBe(true)
    expect(d.reason).toContain('•••• 7518')
    expect(d.reason).not.toContain('490154203237518')
  })

  it.each([
    ['Excel', { title: 'Orders.xlsx - Excel', process: 'EXCEL.EXE', focusName: 'A1' }],
    ['a search box', { focusName: 'Search orders' }],
    ['Notepad', { title: 'ids.txt - Notepad', process: 'notepad.exe', focusName: 'Text editor' }]
  ])('a card-shaped number in %s asks instead of blocking (review M5)', (_where, w) => {
    const d = evaluate(
      { type: 'type', text: '4242424242424242' },
      { origin: 'agent', activeWindow: { ...browser, focusKnown: true, focusRole: 'edit', ...w } }
    )
    expect(d.risk).toBe('high')
  })

  it('a card-shaped number in a form field stays blocked', () => {
    expect(evaluate({ type: 'type', text: '4242 4242 4242 4242' }, field('IMEI')).risk).toBe(
      'blocked'
    )
  })

  it('a number that fails Luhn is not a card', () => {
    const d = evaluate({ type: 'type', text: '4242 4242 4242 4241' }, field('Message'))
    expect(d.risk).not.toBe('blocked')
  })

  it('input steps typing a card number are blocked', () => {
    const d = evaluate(
      { type: 'input', steps: [{ t: 'type', text: '4111111111111111' }] },
      field('Notes')
    )
    expect(d.risk).toBe('blocked')
  })

  it('a card number typed in two parts into one field is blocked (review M2)', () => {
    const d = evaluate(
      { type: 'type', text: '4242 4242' },
      field('Notes', { focusValue: 'Order notes: 4242 4242 ' })
    )
    expect(d.risk).toBe('blocked')
    expect(d.reason).toMatch(/card number/)
  })

  it('a field that already held a card number does not block later typing', () => {
    const d = evaluate(
      { type: 'type', text: ' thanks' },
      field('Notes', { focusValue: '4242 4242 4242 4242' })
    )
    expect(d.risk).not.toBe('blocked')
  })

  it('the user typing their own card (user-direct) is not blocked', () => {
    const d = evaluate(
      { type: 'type', text: '4242 4242 4242 4242' },
      { ...field('Card number'), origin: 'user-direct' }
    )
    expect(d.risk).not.toBe('blocked')
  })
})

describe('personal details', () => {
  it('a name the user said is fine', () => {
    const d = evaluate(
      { type: 'type', text: 'Anna Berg' },
      { ...field('Full name'), userText: 'book it for Anna Berg' }
    )
    expect(d.risk).not.toBe('high')
  })

  it('a name from the memory profile is high and shows the value', () => {
    const d = evaluate(
      { type: 'type', text: 'Anna Berg' },
      { ...field('Full name'), userText: 'book the second one' }
    )
    expect(d.risk).toBe('high')
    expect(d.needsConfirm).toBe(true)
    expect(d.reason).toContain('“Anna Berg”')
  })

  it('a name the user never said is high in a guest name field (review L1)', () => {
    const d = evaluate(
      { type: 'type', text: 'John Smith' },
      { ...field('Guest name'), userText: 'book the hotel' }
    )
    expect(d.risk).toBe('high')
  })

  it('a short name said as a whole word counts (review L2)', () => {
    const d = evaluate(
      { type: 'type', text: 'Jo' },
      { ...field('Full name'), userText: 'book the hotel in Lyon, my name is Jo' }
    )
    expect(d.risk).not.toBe('high')
    const unsaid = evaluate(
      { type: 'type', text: 'Jo' },
      { ...field('Full name'), userText: 'book it for John' }
    )
    expect(unsaid.risk).toBe('high')
  })

  it('a partial word does not count as said', () => {
    const d = evaluate(
      { type: 'type', text: 'Ann' },
      { ...field('First name'), userText: 'book it for Anna' }
    )
    expect(d.risk).toBe('high')
  })

  it('an email typed anywhere must be said in full', () => {
    const ok = evaluate(
      { type: 'type', text: 'anna@example.com' },
      { ...field('Contact'), userText: 'use anna@example.com' }
    )
    expect(ok.risk).not.toBe('high')
    const bad = evaluate(
      { type: 'type', text: 'anna@example.com' },
      { ...field('Contact'), userText: 'book it' }
    )
    expect(bad.risk).toBe('high')
  })

  it('a phone number said with spaces matches its digits', () => {
    const ok = evaluate(
      { type: 'type', text: '+31 6 12345678' },
      { ...field('Phone'), userText: 'my number is +31 612 345 678' }
    )
    expect(ok.risk).not.toBe('high')
    const bad = evaluate(
      { type: 'type', text: '0612345678' },
      { ...field('Phone'), userText: 'book' }
    )
    expect(bad.risk).toBe('high')
  })

  it('dates and plain numbers are not phone numbers', () => {
    expect(evaluate({ type: 'type', text: '2026-10-02' }, field('Check-in')).risk).not.toBe('high')
    expect(evaluate({ type: 'type', text: '2' }, field('Guests')).risk).not.toBe('high')
  })

  it('a search box or file name is not a personal field', () => {
    expect(evaluate({ type: 'type', text: 'hotels in Lyon' }, field('Search')).risk).not.toBe(
      'high'
    )
    expect(evaluate({ type: 'type', text: 'report' }, field('File name')).risk).not.toBe('high')
  })

  const excel = (): PolicyCtx => ({
    origin: 'agent',
    activeWindow: {
      title: 'Book1 - Excel',
      process: 'EXCEL.EXE',
      focusKnown: true,
      focusName: 'A1',
      focusRole: 'edit'
    }
  })

  it.each(['1.000.000', '3.14159265', '1234567', '+31 6 12345678', 'anna@example.com'])(
    'data typed into a spreadsheet is not a personal detail: %s (review M4)',
    (text) => {
      expect(evaluate({ type: 'type', text }, excel()).risk).toBe('low')
    }
  )

  it.each([
    ['12345678', 'Search orders'],
    ['anna@example.com', 'Search contacts'],
    ['2026 10 05', 'Date'],
    ['1234567', 'Order number']
  ])('%s into %s is not a personal detail (review M4)', (text, name) => {
    expect(evaluate({ type: 'type', text }, field(name)).risk).not.toBe('high')
  })

  it('a phone number into a form field is still high unless said', () => {
    expect(evaluate({ type: 'type', text: '+31 6 12345678' }, field('Phone')).risk).toBe('high')
    expect(evaluate({ type: 'type', text: '+31 6 12345678' }, field('Contact')).risk).toBe('high')
    const said = evaluate(
      { type: 'type', text: '+31 6 12345678' },
      { ...field('Phone'), userText: 'my number is +31 6 12345678' }
    )
    expect(said.risk).not.toBe('high')
  })

  it('the user typing their own details is not rated', () => {
    const d = evaluate(
      { type: 'type', text: 'Anna Berg' },
      { ...field('Full name'), origin: 'user-direct' }
    )
    expect(d.risk).not.toBe('high')
  })
})

describe('keys into a payment field (review H1)', () => {
  it.each([
    [['4']],
    [['num4']],
    [['shift', '4']],
    [['space']],
    [['ctrl', 'v']],
    [['shift', 'insert']],
    [['ctrl', 'c']],
    [['backspace']]
  ])('agent %j into Card number is blocked', (keys) => {
    expect(evaluate({ type: 'hotkey', keys }, field('Card number')).risk).toBe('blocked')
  })

  it.each(['agent', 'routine', 'mcp'] as const)(
    '%s keys steps into a CVC are blocked',
    (origin) => {
      const d = evaluate(
        { type: 'input', steps: [{ t: 'keys', combo: '4' }] },
        { ...field('CVC'), origin }
      )
      expect(d.risk).toBe('blocked')
    }
  )

  it('Tab and Escape still leave the field', () => {
    expect(evaluate({ type: 'hotkey', keys: ['tab'] }, field('Card number')).risk).not.toBe(
      'blocked'
    )
    expect(evaluate({ type: 'hotkey', keys: ['esc'] }, field('CVC')).risk).not.toBe('blocked')
  })

  it('the user pressing keys there is not blocked', () => {
    const d = evaluate(
      { type: 'hotkey', keys: ['ctrl', 'v'] },
      { ...field('Card number'), origin: 'user-direct' }
    )
    expect(d.risk).toBe('low')
  })
})
