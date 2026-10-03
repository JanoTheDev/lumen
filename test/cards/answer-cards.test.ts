import { afterEach, describe, expect, it, vi } from 'vitest'
import { toModelResponse } from '../../src/main/ai/schema'
import { cardAction, presentCards, setCardsPorts, type CardsPorts } from '../../src/main/cards'
import {
  ANSWER_CARDS_MAX,
  buildModelCards,
  cardColor,
  extractAnswerCards
} from '../../src/main/cards/answer-cards'
import { validateCards } from '../../src/main/cards/schema'
import type { AnswerCards } from '../../src/shared/cards'

const block = (json: unknown): string => '```cards\n' + JSON.stringify(json) + '\n```'

function ports(): CardsPorts & { [K in keyof CardsPorts]: ReturnType<typeof vi.fn> } {
  return {
    showAnswer: vi.fn(),
    openUrl: vi.fn(async () => true),
    saveNote: vi.fn(async () => true),
    openPanel: vi.fn(),
    runQuery: vi.fn(),
    say: vi.fn(),
    copy: vi.fn()
  }
}

afterEach(() => setCardsPorts(null))

describe('cards in a plain answer', () => {
  it('cuts the block out of the markdown and builds valid cards', () => {
    const md = `Here is how.\n\n${block({
      layout: 'carousel',
      cards: [
        {
          kind: 'steps',
          title: 'Make a rule',
          accent: 'blue',
          items: ['Right-click a mail', { text: 'Choose Rules' }],
          buttons: [{ label: 'Do it for me', style: 'primary' }]
        },
        {
          kind: 'stat',
          title: '5 miles',
          value: { text: '8.05 km', trend: 'up' },
          accent: '#0EA5E9'
        }
      ]
    })}`
    const r = extractAnswerCards(md)
    expect(r.markdown).toBe('Here is how.')
    expect(r.cards?.cards).toHaveLength(2)
    const [steps, stat] = r.cards!.cards
    expect(steps.items).toEqual([{ text: 'Right-click a mail' }, { text: 'Choose Rules' }])
    expect(steps.actions).toEqual([{ kind: 'ask', label: 'Do it for me', style: 'primary' }])
    expect(stat.value).toEqual({ text: '8.05 km', trend: 'up' })
    expect(stat.accent).toBe('#0ea5e9')
    expect(validateCards(r.cards).ok).toBe(true)
  })

  it('drops a broken block but still removes it from the text', () => {
    expect(extractAnswerCards('Text\n```cards\n{nope\n```')).toEqual({ markdown: 'Text' })
    // An unfinished block (cut off reply) is removed too.
    expect(extractAnswerCards('Text\n```cards\n{"cards": [').markdown).toBe('Text')
    expect(extractAnswerCards('No cards here').cards).toBeUndefined()
  })

  it('never keeps prices, ratings, pictures, unsafe links or unknown colours', () => {
    const built = buildModelCards({
      cards: [
        {
          kind: 'product',
          title: 'Kettle',
          price: { amount: 20, currency: 'EUR' },
          rating: { value: 5, max: 5 },
          image: { sourceUrl: 'https://x.test/a.jpg' },
          link: 'http://shop.test/k',
          accent: 'chartreuse',
          buttons: [
            { label: 'Buy', action: 'link', url: 'https://192.168.0.2/buy' },
            { label: 'Open', action: 'link', url: 'javascript:alert(1)' },
            { label: 'Shop', url: 'https://shop.test/k', color: 'green' }
          ]
        }
      ]
    })!
    const c = built.cards[0]
    expect(c).not.toHaveProperty('price')
    expect(c).not.toHaveProperty('rating')
    expect(c).not.toHaveProperty('image')
    expect(c).not.toHaveProperty('accent')
    expect(c.links).toEqual([])
    expect(c.actions).toEqual([
      { kind: 'link', label: 'Shop', url: 'https://shop.test/k', color: 'green' }
    ])
  })

  it('caps cards, items and buttons and gives a linked card an Open button', () => {
    const many = buildModelCards({
      cards: Array.from({ length: 9 }, (_, i) => ({
        title: `Card ${i}`,
        items: Array.from({ length: 12 }, (_, j) => `line ${j}`),
        link: 'https://example.com/a',
        buttons: Array.from({ length: 5 }, (_, j) => ({ label: `Ask ${j}` }))
      }))
    })!
    expect(many.cards).toHaveLength(ANSWER_CARDS_MAX)
    expect(many.cards[0].items).toHaveLength(8)
    expect(many.cards[0].actions[0]).toEqual({ kind: 'open', label: 'Open' })
    expect(many.cards[0].actions).toHaveLength(4)
    expect(buildModelCards({ cards: [{ kind: 'stat' }] })).toBeNull()
  })

  it('reads colours the model writes', () => {
    expect(cardColor('Teal')).toBe('teal')
    expect(cardColor('#ABCDEF')).toBe('#abcdef')
    expect(cardColor('#abc')).toBeUndefined()
    expect(cardColor('rgb(1,2,3)')).toBeUndefined()
  })

  it('an answer reply carries its cards and keeps spoken text when markdown was only cards', () => {
    const r = toModelResponse({
      mode: 'answer',
      spoken: 'Five miles is about eight kilometres.',
      markdown: block({ cards: [{ kind: 'stat', title: '5 miles', value: '8.05 km' }] })
    })
    expect(r).toMatchObject({ mode: 'answer', text: 'Five miles is about eight kilometres.' })
    if (r.mode !== 'answer') throw new Error('mode')
    expect(r.markdown).toBeUndefined()
    expect(r.cards?.cards[0].value).toEqual({ text: '8.05 km' })
  })
})

describe('card buttons', () => {
  const set = (): AnswerCards => ({
    layout: 'carousel',
    sources: [],
    cards: [
      {
        id: 'a1',
        kind: 'steps',
        title: 'Make a rule',
        facts: [{ label: 'Takes', value: '2 min' }],
        items: [{ text: 'Open Outlook' }, { text: 'Click Rules' }],
        links: [],
        actions: [
          { kind: 'link', label: 'Docs', url: 'https://example.com/docs' },
          { kind: 'link', label: 'Video', url: 'https://example.com/video' },
          { kind: 'ask', label: 'Do it for me' },
          { kind: 'copy' }
        ]
      }
    ]
  })

  it('a link button opens its own page, by index', async () => {
    const p = ports()
    setCardsPorts(p, { resolve: async () => null })
    const r = presentCards('x', set())
    if (!r.ok) throw new Error(r.error)
    await cardAction({ id: r.id, cardId: 'a1', action: 'link', index: 1 })
    expect(p.openUrl).toHaveBeenCalledWith('https://example.com/video')
  })

  it('an ask button runs exactly its label; copy copies the card text', async () => {
    const p = ports()
    setCardsPorts(p, { resolve: async () => null })
    const r = presentCards('x', set())
    if (!r.ok) throw new Error(r.error)
    await cardAction({ id: r.id, cardId: 'a1', action: 'ask', index: 2 })
    expect(p.runQuery).toHaveBeenCalledWith('Do it for me')
    const copied = await cardAction({ id: r.id, cardId: 'a1', action: 'copy', index: 3 })
    expect(copied).toEqual({ ok: true, message: 'Copied.' })
    expect(p.copy).toHaveBeenCalledWith(
      'Make a rule\n1. Open Outlook\n2. Click Rules\nTakes: 2 min'
    )
  })

  it('the validator wants a url on link buttons only and a label on ask', () => {
    const bad = set()
    bad.cards[0].actions = [{ kind: 'ask' }]
    expect(validateCards(bad).ok).toBe(false)
    bad.cards[0].actions = [{ kind: 'copy', url: 'https://example.com' }]
    expect(validateCards(bad).ok).toBe(false)
    bad.cards[0].actions = [{ kind: 'link', label: 'Go' }]
    expect(validateCards(bad).ok).toBe(false)
    bad.cards[0].actions = [{ kind: 'copy', color: 'red', style: 'plain' }]
    expect(validateCards(bad).ok).toBe(true)
    bad.cards[0].accent = '#12345' as never
    expect(validateCards(bad).ok).toBe(false)
  })
})
