// Answer card views (05 T37): pure helpers and static markup (no DOM library in this repo;
// keyboard and screen reader behaviour is a hand test).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnswerPageView } from '../../src/renderer/src/cards/AnswerPage'
import { CardItem } from '../../src/renderer/src/cards/CardItem'
import { CardStripView } from '../../src/renderer/src/cards/CardStrip'
import {
  bestIds,
  checkedAgo,
  factColumns,
  filterCards,
  formatPrice,
  formatRating,
  isDataImage,
  readOrder,
  sortCards,
  windowStart
} from '../../src/renderer/src/cards/view'
import { parseRoute } from '../../src/renderer/src/panel/routes'
import { CHECKED, hotelView } from './fixture'

const now = CHECKED + 2 * 3_600_000
const noop = (): void => {}

describe('card helpers', () => {
  it('formats price and rating', () => {
    const [a, b] = hotelView().cards
    expect(formatPrice(a.price!)).toBe('€140 a night')
    expect(formatPrice({ amount: 9.5, currency: 'USD', sourceId: 's' })).toBe('$9.50')
    expect(formatRating(a.rating!)).toBe('4.4 out of 5 (1,203 reviews)')
    expect(formatRating(b.rating!)).toBe('8.1 out of 10')
    expect(checkedAgo(CHECKED, now)).toBe('2 h ago')
  })

  it('reads title, price, rating, facts, then source', () => {
    const v = hotelView()
    expect(readOrder(v.cards[0], v.sources, now)).toEqual([
      'Hotel Azur, Promenade des Anglais',
      'Price €140 a night, 3–5 May',
      'Rated 4.4 out of 5 (1,203 reviews)',
      'Beach: 2 min walk',
      'Parking: Yes',
      'Sea view',
      'From hotels.test, checked 2 h ago'
    ])
  })

  it('sorts by price and rating with missing values last', () => {
    const cards = hotelView().cards
    expect(sortCards(cards, 'price').map((c) => c.id)).toEqual(['h2', 'h1', 'h3'])
    expect(sortCards(cards, 'rating').map((c) => c.id)).toEqual(['h1', 'h2', 'h3'])
    expect(sortCards(cards, 'relevance').map((c) => c.id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('compares prices in the most common currency only', () => {
    const base = hotelView().cards[2]
    const priced = (id: string, amount: number, currency: string): typeof base => ({
      ...base,
      id,
      price: { amount, currency, sourceId: 's1' }
    })
    const cards = [
      priced('usd', 50, 'USD'),
      priced('eur40', 40, 'EUR'),
      priced('gbp', 20, 'GBP'),
      priced('eur30', 30, 'EUR'),
      { ...base, id: 'none' }
    ]
    expect(sortCards(cards, 'price').map((c) => c.id)).toEqual([
      'eur30',
      'eur40',
      'gbp',
      'usd',
      'none'
    ])
    expect(bestIds(cards).cheapest).toBe('eur30')
  })

  it('filters on chips and lists fact columns', () => {
    const v = hotelView()
    expect(filterCards(v.cards, v.filters).map((c) => c.id)).toEqual(['h1', 'h3'])
    expect(factColumns(v.cards)).toEqual(['Beach', 'Parking', 'Area'])
  })

  it('keeps the focused card inside the carousel window', () => {
    expect(windowStart(0, 4, 6)).toBe(2)
    expect(windowStart(3, 1, 6)).toBe(1)
    expect(windowStart(9, 9, 5)).toBe(2)
    expect(windowStart(0, 0, 2)).toBe(0)
  })

  it('draws only data URLs', () => {
    expect(isDataImage('data:image/jpeg;base64,AAAA')).toBe(true)
    expect(isDataImage('https://img.test/a.jpg')).toBe(false)
    expect(isDataImage('data:image/svg+xml;base64,AAAA')).toBe(false)
  })
})

describe('card markup', () => {
  it('a card is a heading-led article in screen reader order with alt text', () => {
    const v = hotelView()
    const html = renderToStaticMarkup(
      createElement(CardItem, { card: v.cards[0], sources: v.sources, now, onAction: noop })
    )
    const at = (s: string): number => html.indexOf(s)
    expect(at('<h3')).toBeGreaterThanOrEqual(0)
    expect(at('Hotel Azur')).toBeLessThan(at('€140'))
    expect(at('€140')).toBeLessThan(at('4.4 out of 5'))
    expect(at('4.4 out of 5')).toBeLessThan(at('2 min walk'))
    expect(at('2 min walk')).toBeLessThan(at('From hotels.test'))
    expect(html).toContain('alt="Hotel Azur seen from the sea"')
    expect(html).toContain('>Book it</button>')
    expect(html).not.toMatch(/src="https?:/)
  })

  it('answer kinds draw their own middle, colours and button looks', () => {
    const base = { facts: [], links: [], actions: [] }
    const draw = (card: Parameters<typeof CardItem>[0]['card']): string =>
      renderToStaticMarkup(createElement(CardItem, { card, sources: [], now, onAction: noop }))
    const steps = draw({
      ...base,
      id: 's',
      kind: 'steps',
      title: 'Make a rule',
      accent: 'teal',
      items: [{ text: 'Open Outlook' }, { text: 'Click Rules' }],
      actions: [{ kind: 'ask', label: 'Do it for me', style: 'primary' }, { kind: 'copy' }]
    })
    expect(steps).toContain('data-accent="teal"')
    expect(steps).toMatch(/<ol class="cd-steps">.*Open Outlook.*Click Rules.*<\/ol>/)
    expect(steps).toContain('class="cd-btn is-primary"')
    expect(steps).toContain('aria-label="Copy"')
    const stat = draw({
      ...base,
      id: 't',
      kind: 'stat',
      title: '5 miles',
      accent: '#0ea5e9',
      value: { text: '8.05 km', change: '+2%', trend: 'up' },
      actions: [{ kind: 'copy' }]
    })
    expect(stat).toContain('--cd-accent:#0ea5e9')
    expect(stat).toContain('cd-stat__change is-up')
    // Only an icon button: it sits in the corner instead of its own row.
    expect(stat).toContain('tools-only')
    const pc = draw({
      ...base,
      id: 'p',
      kind: 'pros-cons',
      title: 'A or B',
      pros: ['Fast'],
      cons: ['Big']
    })
    expect(pc.indexOf('Fast')).toBeLessThan(pc.indexOf('Big'))
    const callout = draw({ ...base, id: 'c', kind: 'callout', tone: 'warning', title: 'Careful' })
    expect(callout).toContain('tone-warning')
  })

  it('a remote image URL is never drawn', () => {
    const v = hotelView()
    const card = { ...v.cards[0], image: { src: 'https://img.test/a.jpg', alt: 'x' } }
    const html = renderToStaticMarkup(createElement(CardItem, { card, sources: v.sources, now }))
    expect(html).not.toContain('<img')
  })

  it('the strip is a list of list items with nav and Show all only when needed', () => {
    const v = hotelView()
    const html = renderToStaticMarkup(
      createElement(CardStripView, { view: v, now, onAction: noop })
    )
    expect(html).toContain('role="list"')
    expect(html.match(/role="listitem"/g)).toHaveLength(3)
    expect(html).toContain('aria-label="3 results"')
    expect(html).toContain('1 of 3')
    expect(html).not.toContain('Show all')
    const more = { ...v, cards: [...v.cards, { ...v.cards[2], id: 'h4', title: 'Fourth' }] }
    expect(
      renderToStaticMarkup(createElement(CardStripView, { view: more, now, onAction: noop }))
    ).toContain('Show all')
  })

  it('simple mode shows one card with Back and Next', () => {
    const html = renderToStaticMarkup(
      createElement(CardStripView, { view: hotelView(), simple: true, now, onAction: noop })
    )
    expect(html.match(/role="listitem"/g)).toHaveLength(1)
    expect(html).toContain('Back')
    expect(html).toContain('Next')
    expect(html).toContain('1 of 3')
  })

  it('the page shows a table sorted by price and filter chips', () => {
    const html = renderToStaticMarkup(
      createElement(AnswerPageView, {
        view: hotelView(),
        layout: 'table',
        onLayout: noop,
        onAction: noop,
        now,
        initialSort: 'price'
      })
    )
    expect(html).toContain('<table')
    expect(html.indexOf('Old Town Rooms')).toBeLessThan(html.indexOf('Hotel Azur'))
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('Near the beach')
    const filtered = renderToStaticMarkup(
      createElement(AnswerPageView, {
        view: hotelView(),
        layout: 'grid',
        onLayout: noop,
        onAction: noop,
        now,
        initialFilters: ['Near the beach']
      })
    )
    expect(filtered).toContain('2 of 3 results')
    expect(filtered).not.toContain('Old Town Rooms')
  })
})

describe('answer route', () => {
  it('parses #/answer/<id> and its table view', () => {
    expect(parseRoute('#/answer/c_test0001')).toEqual({
      name: 'answer',
      id: 'c_test0001',
      table: false
    })
    expect(parseRoute('#/answer/c_test0001/table')).toMatchObject({ table: true })
    expect(parseRoute('#/answer/../x')).toEqual({ name: 'settings', section: 'general' })
  })
})
