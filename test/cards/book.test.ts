import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnswerCards, Card } from '@shared/cards'
import type { ModelResponse } from '@shared/types'
import {
  BOOKING_GUIDANCE,
  bookingGoal,
  bookingLink,
  confirmationCards,
  parseConfirmation,
  setBookPorts,
  startBooking,
  type BookPorts
} from '../../src/main/cards/book'
import { validateCards } from '../../src/main/cards/schema'

const card: Card = {
  id: 'c2',
  kind: 'lodging',
  title: 'Hotel Rosa',
  subtitle: 'Lyon centre',
  price: { amount: 120, currency: 'EUR', unit: 'night', sourceId: 's1' },
  facts: [
    { label: 'Dates', value: '3–5 May' },
    { label: 'Rooms', value: '1' }
  ],
  links: [{ label: 'Book', url: 'https://hotels.example.com/rosa?d=3-5-may' }],
  actions: [{ kind: 'do', label: 'Book it' }]
}

const cards: AnswerCards = {
  layout: 'list',
  cards: [card],
  sources: [{ id: 's1', title: 'Example', url: 'https://src.example.org/rosa', checkedAt: 1 }]
}

const done: ModelResponse = {
  mode: 'answer',
  text: 'Booked the room.\nReference: ABC-12345\nDates: 3–5 May 2027\nPrice: €252.50'
}

interface Fake extends BookPorts {
  calls: { goal: string; opts: { userText: string; observedText: string } }[]
  opened: string[]
  shown: { text: string; cards: unknown }[]
  said: string[]
  ended: number
}

function fake(result: ModelResponse | Error = done, over: Partial<BookPorts> = {}): Fake {
  const f: Fake = {
    calls: [],
    opened: [],
    shown: [],
    said: [],
    ended: 0,
    busy: () => false,
    async openUrl(url) {
      f.opened.push(url)
      return true
    },
    async run(goal, opts) {
      f.calls.push({ goal, opts })
      if (result instanceof Error) throw result
      return result
    },
    present(text, c) {
      f.shown.push({ text, cards: c })
      const check = validateCards(c)
      return check.ok ? { ok: true, id: 'k1' } : { ok: false, error: check.error }
    },
    say: (t) => void f.said.push(t),
    scope: () => ({ signal: new AbortController().signal, end: () => void f.ended++ }),
    ...over
  }
  return f
}

beforeEach(() => setBookPorts(null))

describe('booking goal and link', () => {
  it('starts at the card link, else the price source', () => {
    expect(bookingLink(card)).toBe('https://hotels.example.com/rosa?d=3-5-may')
    expect(bookingLink({ ...card, links: [] }, cards)).toBe('https://src.example.org/rosa')
    expect(bookingLink({ ...card, links: [], price: undefined })).toBeNull()
  })

  it('names the card, price and dates', () => {
    expect(bookingGoal(card, 'https://hotels.example.com/rosa')).toBe(
      'Book Hotel Rosa (120 EUR per night, Dates 3–5 May) on https://hotels.example.com/rosa'
    )
  })

  it('guidance covers login / captcha / 3-D Secure, payment fields and the reference', () => {
    expect(BOOKING_GUIDANCE).toMatch(/captcha/)
    expect(BOOKING_GUIDANCE).toMatch(/3-D Secure/)
    expect(BOOKING_GUIDANCE).toMatch(/say ‘go’ when done/)
    expect(BOOKING_GUIDANCE).toMatch(/CVC/)
    expect(BOOKING_GUIDANCE).toMatch(/Reference: …/)
  })
})

describe('parseConfirmation', () => {
  it('reads reference, dates and price', () => {
    expect(parseConfirmation(done.mode === 'answer' ? done.text : '')).toEqual({
      reference: 'ABC-12345',
      dates: '3–5 May 2027',
      price: '€252.50'
    })
  })

  it('reads other labels', () => {
    expect(parseConfirmation('All set.\n- Confirmation number: 998877')?.reference).toBe('998877')
    expect(parseConfirmation('Booking reference #XK2P')?.reference).toBe('XK2P')
  })

  it('no reference → null', () => {
    expect(parseConfirmation('I could not finish: the site asked for a login.')).toBeNull()
    expect(parseConfirmation('Reference: none')).toBeNull()
  })

  it('the confirmation card validates', () => {
    const c = confirmationCards(card, 'https://hotels.example.com/rosa', {
      reference: 'ABC',
      price: '€1'
    })
    expect(validateCards(c).ok).toBe(true)
    expect(c.cards).toHaveLength(1)
    expect(c.cards[0].kind).toBe('generic')
    expect(c.cards[0].facts.map((f) => f.label)).toEqual(['Reference', 'Price'])
  })
})

describe('startBooking', () => {
  it('without ports it is not ready', async () => {
    expect((await startBooking(card)).status).toBe('not-ready')
  })

  it('opens the link, runs the agent task and shows the confirmation card', async () => {
    const f = fake()
    setBookPorts(f)
    const r = await startBooking(card, { cards, userText: 'book the second one' })
    expect(r).toMatchObject({ status: 'done', reference: 'ABC-12345' })
    expect(f.opened).toEqual(['https://hotels.example.com/rosa?d=3-5-may'])
    expect(f.calls).toHaveLength(1)
    const { goal, opts } = f.calls[0]
    expect(goal.startsWith('Book Hotel Rosa (120 EUR per night, Dates 3–5 May) on https://')).toBe(
      true
    )
    expect(goal).toContain(BOOKING_GUIDANCE)
    // The user's words and the site they picked are theirs; the card's text is observed.
    expect(opts.userText).toBe('book the second one (hotels.example.com)')
    expect(opts.observedText).toContain('Hotel Rosa')
    expect(opts.userText).not.toContain('Rosa')
    expect(f.shown).toHaveLength(1)
    expect(f.shown[0].text).toBe('Booked Hotel Rosa. Reference ABC-12345.')
    expect(f.ended).toBe(1)
  })

  it('busy: another task runs, nothing starts', async () => {
    const f = fake(done, { busy: () => true })
    setBookPorts(f)
    expect((await startBooking(card)).status).toBe('busy')
    expect(f.opened).toEqual([])
    expect(f.said[0]).toMatch(/Another task/)
  })

  it('no link', async () => {
    const f = fake()
    setBookPorts(f)
    expect((await startBooking({ ...card, links: [], price: undefined })).status).toBe('no-link')
    expect(f.calls).toHaveLength(0)
  })

  it('the page did not open', async () => {
    const f = fake(done, { openUrl: async () => false })
    setBookPorts(f)
    expect((await startBooking(card)).status).toBe('failed')
    expect(f.calls).toHaveLength(0)
  })

  it('no reference: the task summary is said, no card', async () => {
    const f = fake({ mode: 'answer', text: 'The site wants a login; I stopped.' })
    setBookPorts(f)
    const r = await startBooking(card)
    expect(r.status).toBe('failed')
    expect(f.said).toEqual(['The site wants a login; I stopped.'])
    expect(f.shown).toHaveLength(0)
  })

  it('quiet: the caller shows the text', async () => {
    const f = fake({ mode: 'answer', text: 'Stopped at the payment page.' })
    setBookPorts(f)
    const r = await startBooking(card, { quiet: true })
    expect(r.text).toBe('Stopped at the payment page.')
    expect(f.said).toEqual([])
  })

  it('a cancel is reported as stopped and uses the caller signal', async () => {
    const ac = new AbortController()
    const f = fake(done, {
      async run() {
        ac.abort()
        const e = new Error('Cancelled')
        e.name = 'CancelledError'
        throw e
      }
    })
    setBookPorts(f)
    const r = await startBooking(card, { signal: ac.signal })
    expect(r.status).toBe('cancelled')
    expect(f.ended).toBe(0)
  })

  it('an error is reported', async () => {
    const f = fake(new Error('An agent task is already running.'))
    setBookPorts(f)
    const r = await startBooking(card)
    expect(r.status).toBe('failed')
    expect(r.text).toMatch(/already running/)
  })
})

describe('cards.do wiring', () => {
  it('the Book button starts a booking of that card', async () => {
    vi.resetModules()
    const startBooking = vi.fn(async () => ({ status: 'done', text: '' }))
    vi.doMock('../../src/main/cards/book', async (orig) => ({
      ...(await orig<object>()),
      startBooking,
      setBookPorts: vi.fn()
    }))
    vi.doMock('../../src/main/a11y', () => ({ announce: vi.fn() }))
    vi.doMock('../../src/main/actions/executor', () => ({ executeActions: vi.fn() }))
    vi.doMock('../../src/main/agent-mode/session', () => ({
      agentRunning: () => false,
      runAgentTask: vi.fn()
    }))
    vi.doMock('../../src/main/windows/assistant', () => ({ showAnswer: vi.fn() }))
    vi.doMock('../../src/main/agent/instance', () => ({ requireAgent: vi.fn() }))
    vi.doMock('../../src/main/cards/images', () => ({
      cardImages: { resolve: async () => null }
    }))
    const { installBooking } = await import('../../src/main/cards/book-install')
    const { bus } = await import('../../src/main/bus')
    const { presentCards } = await import('../../src/main/cards/index')
    installBooking()
    const shown = presentCards('Hotels', cards)
    expect(shown.ok).toBe(true)
    if (!shown.ok) return
    bus.emit({ type: 'cards.do', id: shown.id, cardId: 'c2', label: 'Book it' })
    expect(startBooking).toHaveBeenCalledTimes(1)
    expect(startBooking).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c2' }),
      expect.objectContaining({ userText: 'Book it' })
    )
    bus.emit({ type: 'cards.do', id: shown.id, cardId: 'nope', label: 'Book it' })
    expect(startBooking).toHaveBeenCalledTimes(1)
    vi.resetModules()
  })
})
