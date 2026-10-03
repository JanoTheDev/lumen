// Card kinds (05 T42): the key line per kind, the comparison table tags, entity summaries in
// the schema and markup, trip times only from pages read, and the kind guidance in the prompts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CardView, CardsView } from '../../src/shared/cards'
import {
  CARDS_RULE_BACKGROUND,
  CARDS_RULE_FOREGROUND,
  buildAnswerCards,
  clockTimes,
  normUrl,
  timesSeen,
  type PresentCardsInput
} from '../../src/main/cards/research'
import { validateCards } from '../../src/main/cards/schema'
import { AnswerPageView } from '../../src/renderer/src/cards/AnswerPage'
import { CardItem } from '../../src/renderer/src/cards/CardItem'
import { bestIds, keyLine, readOrder, restFacts } from '../../src/renderer/src/cards/view'
import { CHECKED, hotelCards, hotelView } from './fixture'

const now = CHECKED + 60_000
const noop = (): void => {}

const view = (over: Partial<CardView>): CardView => ({
  id: 'x1',
  kind: 'generic',
  title: 'Thing',
  facts: [],
  links: [],
  actions: [],
  ...over
})

const recipe = view({
  kind: 'recipe',
  title: 'Ratatouille',
  facts: [
    { label: 'Time', value: '1 h 10 min' },
    { label: 'Servings', value: '4' },
    { label: 'Difficulty', value: 'Easy' }
  ]
})
const product = view({
  kind: 'product',
  title: 'Kettle K2',
  price: { amount: 49, currency: 'EUR', sourceId: 's1' },
  facts: [
    { label: 'Store', value: 'Coolblue' },
    { label: 'Availability', value: 'In stock' },
    { label: 'Capacity', value: '1.7 l' }
  ]
})
const trip = view({
  kind: 'trip',
  title: 'Paris → Lyon',
  facts: [
    { label: 'Departs', value: '08:12' },
    { label: 'Arrives', value: '10:08' },
    { label: 'Duration', value: '1 h 56 min' },
    { label: 'Changes', value: '0' }
  ]
})
const entity = view({
  kind: 'entity',
  title: 'Claude Monet',
  subtitle: 'French painter (1840–1926)',
  summary: {
    text: 'Oscar-Claude Monet was a French painter and founder of impressionist painting.',
    url: 'https://en.wikipedia.org/wiki/Claude_Monet',
    source: 'Wikipedia'
  },
  facts: [{ label: 'Born', value: '14 November 1840' }]
})

describe('key line per kind', () => {
  it('recipe: time and servings', () => {
    const line = keyLine(recipe)
    expect(line.items).toEqual(['1 h 10 min', 'Serves 4'])
    expect(restFacts(recipe, line).map((f) => f.label)).toEqual(['Difficulty'])
  })

  it('product: store and stock, price stays its own line', () => {
    const line = keyLine(product)
    expect(line.items).toEqual(['At Coolblue', 'In stock'])
    expect(restFacts(product, line).map((f) => f.label)).toEqual(['Capacity'])
  })

  it('trip: times, duration, direct', () => {
    expect(keyLine(trip).items).toEqual(['08:12 → 10:08', '1 h 56 min', 'Direct'])
    const one = view({ kind: 'trip', facts: [{ label: 'Changes', value: '2' }] })
    expect(keyLine(one).items).toEqual(['2 changes'])
    expect(
      keyLine(view({ kind: 'trip', facts: [{ label: 'Departs', value: '9:00' }] })).items
    ).toEqual(['Leaves 9:00'])
  })

  it('other kinds have none', () => {
    expect(keyLine(hotelView().cards[0]).items).toEqual([])
    expect(keyLine(entity).items).toEqual([])
  })

  it('reads the key line after the title and the summary after the rating', () => {
    expect(readOrder(recipe, [], now)).toEqual([
      'Ratatouille',
      '1 h 10 min, Serves 4',
      'Difficulty: Easy'
    ])
    expect(readOrder(entity, [], now)).toEqual([
      'Claude Monet, French painter (1840–1926)',
      'Oscar-Claude Monet was a French painter and founder of impressionist painting. From Wikipedia',
      'Born: 14 November 1840'
    ])
  })
})

describe('card markup', () => {
  it('draws the key line once and leaves its facts out of the list', () => {
    const html = renderToStaticMarkup(
      createElement(CardItem, { card: trip, sources: [], now, onAction: noop })
    )
    expect(html).toContain('cd-card__key')
    expect(html).toContain('08:12 → 10:08')
    expect(html).not.toContain('<dt>Departs</dt>')
  })

  it('entity: one-line subtitle and a summary with its source', () => {
    const html = renderToStaticMarkup(createElement(CardItem, { card: entity, sources: [], now }))
    expect(html).toContain('cd-card__sub is-oneline')
    expect(html).toContain('founder of impressionist painting')
    expect(html).toContain('From Wikipedia')
  })

  it('comparison table tags the lowest price and the best rating', () => {
    const v = hotelView()
    expect(bestIds(v.cards)).toEqual({ cheapest: 'h2', best: 'h1' })
    const html = renderToStaticMarkup(
      createElement(AnswerPageView, {
        view: v,
        layout: 'table',
        onLayout: noop,
        onAction: noop,
        now
      })
    )
    expect(html.match(/cd-tag/g)).toHaveLength(2)
    expect(html).toContain('Lowest')
    expect(html).toContain('Top rated')
  })

  it('no tags with a single priced card', () => {
    const v: CardsView = { ...hotelView(), cards: hotelView().cards.slice(0, 1) }
    expect(bestIds(v.cards)).toEqual({})
  })
})

describe('schema', () => {
  it('accepts an https summary and refuses others', () => {
    const c = hotelCards()
    c.cards[0].summary = {
      text: 'A hotel.',
      url: 'https://en.wikipedia.org/wiki/X',
      source: 'Wikipedia'
    }
    expect(validateCards(c).ok).toBe(true)
    c.cards[0].summary = {
      text: 'A hotel.',
      url: 'http://en.wikipedia.org/wiki/X',
      source: 'Wikipedia'
    }
    expect(validateCards(c).ok).toBe(false)
    c.cards[0].summary = { text: 'x'.repeat(401), url: 'https://a.test/x', source: 'Wikipedia' }
    expect(validateCards(c).ok).toBe(false)
  })
})

describe('trip times from pages read', () => {
  it('finds clock times in the forms pages use', () => {
    expect(clockTimes('08:12 → 10.08, then 14h30')).toEqual(['8:12', '10:08', '14:30'])
    expect(clockTimes('1 h 56 min, €12')).toEqual([])
    expect(timesSeen('08:12', 'Departure 8:12 Paris Gare de Lyon')).toBe(true)
    expect(timesSeen('08:15', 'Departure 8:12')).toBe(false)
    expect(timesSeen('1 h 56 min', 'anything')).toBe(true)
    // Prices and dates on a page are not clock times.
    expect(timesSeen('Departs 12:50', 'Ticket €12.50, 03.05.2026')).toBe(false)
    expect(timesSeen('Departs 3:05', 'Travel date 03.05.2026')).toBe(false)
    expect(timesSeen('Departs 12:50', 'Departure 12h50, €12.50')).toBe(true)
    expect(timesSeen('Departs 20:05', 'leaves 8.05 pm')).toBe(false)
    expect(timesSeen('Departs 8:05 pm', 'leaves 8.05 pm')).toBe(true)
  })

  it('drops trip times that are not on a page the task read', () => {
    const input: PresentCardsInput = {
      text: 'Two trains to Lyon.',
      layout: 'table',
      sources: [{ id: 's1', title: 'trains.test', url: 'https://trains.test/paris-lyon' }],
      filters: [],
      cards: [
        {
          kind: 'trip',
          title: 'TGV 6601',
          subtitle: '',
          link: 'https://trains.test/paris-lyon',
          price: [],
          rating: [],
          facts: [
            { label: 'Departs', value: '08:12' },
            { label: 'Arrives', value: '10:30' },
            { label: 'Duration', value: '1 h 56 min' }
          ],
          badges: [],
          accent: '',
          doLabel: ''
        }
      ]
    }
    const seen = {
      urls: new Set([normUrl('https://trains.test/paris-lyon')!]),
      text: '08:12 10:08',
      pages: new Map()
    }
    const r = buildAnswerCards(input, seen, now)
    if (!r.ok) throw new Error(r.error)
    expect(r.cards.cards[0].facts.map((f) => f.label)).toEqual(['Departs', 'Duration'])
    expect(r.dropped).toEqual(['TGV 6601: Arrives 10:30 is not on the pages read'])
  })

  it('other kinds keep their times', () => {
    const r = buildAnswerCards(
      {
        text: 'One place.',
        layout: 'carousel',
        sources: [],
        filters: [],
        cards: [
          {
            kind: 'place',
            title: 'Museum',
            subtitle: '',
            link: '',
            price: [],
            rating: [],
            facts: [{ label: 'Opens', value: '09:00' }],
            badges: [],
            accent: '',
            doLabel: ''
          }
        ]
      },
      { urls: new Set(), text: '', pages: new Map() },
      now
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.cards.cards[0].facts).toHaveLength(1)
  })
})

describe('prompt guidance', () => {
  it('names the kinds, their fact labels and the table layout', () => {
    for (const rule of [CARDS_RULE_FOREGROUND, CARDS_RULE_BACKGROUND]) {
      expect(rule).toMatch(/recipe \(facts "Time", "Servings"\)/)
      expect(rule).toMatch(/"Departs", "Arrives"/)
      expect(rule).toMatch(/entity/)
      expect(rule).toMatch(/Layout table when the user compares/)
    }
  })
})
