// Test data for answer cards (05 Phase R): three hotels in Nice with sources, a filter chip and
// one card without price. Plain https test hosts; nothing here is fetched.
import type { AnswerCards, CardsView } from '../../src/shared/cards'

export const CHECKED = Date.UTC(2026, 9, 1, 10, 0, 0)

export function hotelCards(): AnswerCards {
  return {
    layout: 'carousel',
    sources: [
      { id: 's1', title: 'hotels.test', url: 'https://hotels.test/nice', checkedAt: CHECKED },
      { id: 's2', title: 'reviews.test', url: 'https://reviews.test/nice', checkedAt: CHECKED }
    ],
    filters: [{ label: 'Near the beach', match: 'beach' }],
    cards: [
      {
        id: 'h1',
        kind: 'lodging',
        title: 'Hotel Azur',
        subtitle: 'Promenade des Anglais',
        image: {
          sourceUrl: 'https://img.hotels.test/azur.jpg',
          pageUrl: 'https://hotels.test/azur',
          alt: 'Hotel Azur seen from the sea'
        },
        price: { amount: 140, currency: 'EUR', unit: 'night', note: '3–5 May', sourceId: 's1' },
        rating: { value: 4.4, max: 5, count: 1203, sourceId: 's2' },
        facts: [
          { label: 'Beach', value: '2 min walk' },
          { label: 'Parking', value: 'Yes' }
        ],
        badges: ['Sea view'],
        links: [{ label: 'hotels.test', url: 'https://hotels.test/azur' }],
        actions: [{ kind: 'open' }, { kind: 'save' }, { kind: 'do', label: 'Book it' }]
      },
      {
        id: 'h2',
        kind: 'lodging',
        title: 'Old Town Rooms',
        price: { amount: 95, currency: 'EUR', unit: 'night', sourceId: 's1' },
        rating: { value: 8.1, max: 10, sourceId: 's2' },
        facts: [{ label: 'Parking', value: 'No' }],
        links: [{ label: 'hotels.test', url: 'https://hotels.test/old-town' }],
        actions: [{ kind: 'open' }, { kind: 'compare' }]
      },
      {
        id: 'h3',
        kind: 'lodging',
        title: 'Villa Cimiez',
        facts: [{ label: 'Area', value: 'Hills, 20 min to the beach' }],
        links: [],
        actions: [{ kind: 'save' }]
      }
    ]
  }
}

/** The fixture as renderers get it (image resolved to a tiny data URL). */
export function hotelView(): CardsView {
  const c = hotelCards()
  return {
    id: 'c_test0001',
    text: 'I found 3 hotels in Nice.',
    layout: c.layout,
    sources: c.sources,
    filters: c.filters ?? [],
    createdAt: CHECKED,
    cards: c.cards.map(({ image, ...card }) =>
      image ? { ...card, image: { src: 'data:image/jpeg;base64,AAAA', alt: image.alt } } : card
    )
  }
}
