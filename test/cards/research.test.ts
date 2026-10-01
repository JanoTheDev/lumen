import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../src/main/ai/providers/types'
import {
  buildAnswerCards,
  normUrl,
  numberForms,
  numberSeen,
  observedFrom,
  presentCardsInput,
  type PresentCardsInput
} from '../../src/main/cards/research'
import { validateCards } from '../../src/main/cards/schema'
import { strictCounts } from '../../src/main/ai/providers/anthropic'
import { anthropicJsonSchema } from '../../src/main/ai/providers/structured'

const NOW = Date.UTC(2026, 9, 2, 9, 0, 0)

type CardInput = PresentCardsInput['cards'][number]
const card = (over: Partial<CardInput> = {}): CardInput => ({
  kind: 'lodging',
  title: 'Hotel Azur',
  subtitle: '',
  link: '',
  price: [],
  rating: [],
  facts: [],
  badges: [],
  doLabel: '',
  ...over
})

const input = (over: Partial<PresentCardsInput> = {}): PresentCardsInput => ({
  text: 'I found 2 hotels in Nice.',
  layout: 'carousel',
  sources: [{ id: 's1', title: 'hotels.test', url: 'https://hotels.test/nice' }],
  cards: [card()],
  filters: [],
  ...over
})

const seen = (text: string, ...urls: string[]): ReturnType<typeof observedFrom> => ({
  urls: new Set(urls.map((u) => normUrl(u)!)),
  text
})

describe('numbers on a page', () => {
  it('writes amounts the ways pages do', () => {
    expect(numberForms(1299)).toEqual(expect.arrayContaining(['1299', '1,299', '1.299', '1 299']))
    expect(numberForms(8.6)).toEqual(expect.arrayContaining(['8.6', '8,6', '8.60']))
  })
  it('finds whole numbers only', () => {
    expect(numberSeen(140, '€140 per night')).toBe(true)
    expect(numberSeen(95, 'EUR 95,00 per night')).toBe(true)
    expect(numberSeen(1299, 'total 1.299,00 €')).toBe(true)
    expect(numberSeen(14, '€140 per night')).toBe(false)
    expect(numberSeen(140, '€140.50 per night')).toBe(false)
    expect(numberSeen(4.4, '4.4/5 (1,203 reviews)')).toBe(true)
    expect(numberSeen(4.5, '4.4/5')).toBe(false)
  })
})

describe('observedFrom', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'research hotels https://told.test/x' }] },
    {
      role: 'assistant',
      text: '',
      calls: [
        { id: 'a', name: 'navigate', input: { url: 'https://www.hotels.test/nice/' } },
        { id: 'b', name: 'fetch_url', input: { url: 'https://short.test/r' } },
        { id: 'c', name: 'navigate', input: { url: 'https://failed.test/' } },
        { id: 'd', name: 'lookup_howto', input: {} },
        { id: 'e', name: 'observe', input: { what: 'text' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', id: 'a', content: [{ type: 'text', text: 'Opened.' }] },
        {
          type: 'tool_result',
          id: 'b',
          content: [
            {
              type: 'text',
              text: '<observed source="web https://long.test/page?x=1">price 99</observed>'
            }
          ]
        },
        { type: 'tool_result', id: 'c', isError: true, content: [{ type: 'text', text: 'no' }] },
        {
          type: 'tool_result',
          id: 'd',
          content: [{ type: 'text', text: 'sources: [1] Docs https://learn.test/a.' }]
        },
        {
          type: 'tool_result',
          id: 'e',
          content: [{ type: 'text', text: 'see https://mentioned.test/only' }]
        }
      ]
    }
  ]
  it('counts opened, fetched and looked-up pages, not mentioned ones', () => {
    const o = observedFrom(messages, ['https://front.test/page#top', null])
    expect([...o.urls].sort()).toEqual([
      'front.test/page',
      'hotels.test/nice',
      'learn.test/a',
      'long.test/page',
      'short.test/r'
    ])
    expect(o.text).toContain('price 99')
    expect(o.text).not.toContain('research hotels')
  })
})

describe('buildAnswerCards', () => {
  it('keeps a price read on a page the task read', () => {
    const r = buildAnswerCards(
      input({
        cards: [
          card({
            link: 'https://hotels.test/azur',
            price: [{ amount: 140, currency: '€', unit: 'night', note: '3–5 May', sourceId: 's1' }],
            rating: [{ value: 4.4, max: 5, count: 1203, sourceId: 's1' }],
            doLabel: 'Book it'
          })
        ]
      }),
      seen('€140 per night, 4.4/5', 'https://hotels.test/nice'),
      NOW
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.dropped).toEqual([])
    const c = r.cards.cards[0]
    expect(c.price).toEqual({
      amount: 140,
      currency: 'EUR',
      unit: 'night',
      note: 'from hotels.test, 3–5 May, may change',
      sourceId: 's1'
    })
    expect(c.rating).toEqual({ value: 4.4, max: 5, count: 1203, sourceId: 's1' })
    expect(c.actions.map((a) => a.kind)).toEqual(['open', 'save', 'more', 'do'])
    expect(r.cards.sources[0].checkedAt).toBe(NOW)
    expect(validateCards(r.cards).ok).toBe(true)
  })

  it('drops prices from unread sources and numbers not on the pages', () => {
    const r = buildAnswerCards(
      input({
        sources: [
          { id: 's1', title: 'hotels.test', url: 'https://hotels.test/nice' },
          { id: 's2', title: 'other', url: 'https://other.test/deal' }
        ],
        cards: [
          card({
            title: 'Invented',
            price: [{ amount: 99, currency: 'EUR', unit: '', note: '', sourceId: 's1' }]
          }),
          card({
            title: 'Unread',
            price: [{ amount: 140, currency: 'EUR', unit: '', note: '', sourceId: 's2' }],
            rating: [{ value: 9, max: 10, count: 0, sourceId: 'nope' }]
          })
        ]
      }),
      seen('€140 per night', 'https://hotels.test/nice'),
      NOW
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.cards.cards.every((c) => !c.price && !c.rating)).toBe(true)
    expect(r.dropped).toHaveLength(3)
    // The unread source is not listed; the set still validates.
    expect(r.cards.sources.map((s) => s.id)).toEqual(['s1'])
    expect(validateCards(r.cards).ok).toBe(true)
  })

  it('leaves out bad links and private hosts instead of refusing the set', () => {
    const r = buildAnswerCards(
      input({
        sources: [{ id: 's1', title: 'x', url: 'http://hotels.test/nice' }],
        cards: [
          card({ link: 'javascript:alert(1)' }),
          card({ title: 'B', link: 'https://192.168.1.1/admin' }),
          card({ title: '  ' })
        ]
      }),
      seen('', 'https://hotels.test/nice'),
      NOW
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.cards.cards).toHaveLength(2)
    expect(r.cards.cards.every((c) => c.links.length === 0)).toBe(true)
    expect(r.cards.sources).toEqual([])
    expect(validateCards(r.cards).ok).toBe(true)
  })

  it('refuses no cards or no text', () => {
    expect(buildAnswerCards(input({ cards: [] }), seen(''), NOW).ok).toBe(false)
    expect(buildAnswerCards(input({ text: ' ' }), seen(''), NOW).ok).toBe(false)
  })

  it('has a strict-friendly schema: no optional fields', () => {
    expect(strictCounts(anthropicJsonSchema(presentCardsInput))).toEqual({ optional: 0, unions: 0 })
    expect(presentCardsInput.safeParse(input()).success).toBe(true)
  })
})
