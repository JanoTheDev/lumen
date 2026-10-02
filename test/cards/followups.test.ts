import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswerCards } from '../../src/shared/cards'
import { parseCardIntent, parsePick, resolvePick } from '../../src/main/cards/followups'
import { CardsStore } from '../../src/main/cards/store'
import {
  FOLLOWUP_TTL_MS,
  handleCardsTurn,
  resetCardFocus,
  type CardsTurnDeps
} from '../../src/main/cards/turn'
import { cardsForAnswer } from '../../src/main/cards/answer-link'
import { hotelCards } from './fixture'

describe('parsePick', () => {
  it.each([
    ['the second one', { by: 'index', index: 1 }],
    ['the last hotel', { by: 'index', index: -1 }],
    ['number 3', { by: 'index', index: 2 }],
    ['the cheapest', { by: 'cheapest' }],
    ['the cheapest one', { by: 'cheapest' }],
    ['the most expensive hotel', { by: 'priciest' }],
    ['the best rated one', { by: 'best' }],
    ['the 4-star one', { by: 'stars', n: 4 }],
    ['the four star hotel', { by: 'stars', n: 4 }],
    ['the one near the beach', { by: 'words', words: 'near the beach' }],
    ['the one with parking', { by: 'words', words: 'with parking' }],
    ['the Cimiez one', { by: 'words', words: 'cimiez' }],
    ['it', { by: 'it' }],
    ['that one', { by: 'it' }]
  ])('%s', (text, pick) => expect(parsePick(text)).toEqual(pick))

  it('is null for plain words', () => {
    expect(parsePick('notepad')).toBeNull()
    expect(parsePick('the settings')).toBeNull()
    expect(parsePick('the other one')).toBeNull()
  })
})

describe('parseCardIntent', () => {
  it.each([
    ['open the second one', { kind: 'open', pick: { by: 'index', index: 1 } }],
    ['open it', { kind: 'open', pick: { by: 'it' } }],
    ['Open the cheapest one in my browser.', { kind: 'open', pick: { by: 'cheapest' } }],
    ['save it', { kind: 'save', pick: { by: 'it' } }],
    [
      'save the one near the beach to my notes',
      { kind: 'save', pick: { by: 'words', words: 'near the beach' } }
    ],
    ['save them all', { kind: 'save', pick: 'all' }],
    ['compare them', { kind: 'compare' }],
    ['show them side by side', { kind: 'compare' }],
    ['show me all of them', { kind: 'show-all' }],
    ['the second one', { kind: 'select', pick: { by: 'index', index: 1 } }],
    ['which one is the cheapest', { kind: 'select', pick: { by: 'cheapest' } }],
    ['tell me more about the second one', { kind: 'more', pick: { by: 'index', index: 1 } }],
    [
      'the second one, does it have parking?',
      { kind: 'more', pick: { by: 'index', index: 1 }, question: 'does it have parking' }
    ],
    [
      'does the cheapest one have parking',
      { kind: 'more', pick: { by: 'cheapest' }, question: 'does it have parking' }
    ],
    [
      'how far is the first one from the airport',
      { kind: 'more', pick: { by: 'index', index: 0 }, question: 'how far is it from the airport' }
    ],
    ['cheaper ones', { kind: 'refine', how: 'cheaper' }],
    ['show me cheaper options', { kind: 'refine', how: 'cheaper' }],
    ['something cheaper', { kind: 'refine', how: 'cheaper' }],
    ['more like this', { kind: 'refine', how: 'like', pick: { by: 'it' } }],
    ['more like the second one', { kind: 'refine', how: 'like', pick: { by: 'index', index: 1 } }],
    ['better rated ones', { kind: 'refine', how: 'better' }],
    ['book the second one', { kind: 'book', pick: { by: 'index', index: 1 } }],
    ['book it for me', { kind: 'book', pick: { by: 'it' } }],
    ['open hotel azur', { kind: 'open', pick: { by: 'words', words: 'hotel azur', all: true } }],
    ['open notepad', { kind: 'open', pick: { by: 'words', words: 'notepad', all: true } }]
  ])('%s', (text, intent) => expect(parseCardIntent(text)).toEqual(intent))

  it.each([
    'what is the weather',
    'set a timer for ten minutes',
    'research hotels in Rome',
    'how far is Paris from Nice'
  ])('ignores "%s"', (text) => expect(parseCardIntent(text)).toBeNull())
})

describe('resolvePick', () => {
  const cards = hotelCards().cards
  it('by ordinal, superlative, stars and words', () => {
    const title = (p: Parameters<typeof resolvePick>[0]): string | null => {
      const r = resolvePick(p, cards)
      return r.ok ? r.card.title : null
    }
    expect(title({ by: 'index', index: 1 })).toBe('Old Town Rooms')
    expect(title({ by: 'index', index: -1 })).toBe('Villa Cimiez')
    expect(title({ by: 'cheapest' })).toBe('Old Town Rooms')
    expect(title({ by: 'priciest' })).toBe('Hotel Azur')
    expect(title({ by: 'best' })).toBe('Hotel Azur')
    expect(title({ by: 'words', words: 'with sea view' })).toBe('Hotel Azur')
    expect(title({ by: 'words', words: 'in the hills' })).toBe('Villa Cimiez')
  })
  it('says why when it cannot pick', () => {
    expect(resolvePick({ by: 'index', index: 7 }, cards)).toMatchObject({
      ok: false,
      reason: 'none'
    })
    expect(resolvePick({ by: 'it' }, cards)).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(resolvePick({ by: 'it' }, cards, 'h3')).toMatchObject({ ok: true, index: 2 })
    expect(resolvePick({ by: 'words', words: 'parking' }, cards)).toMatchObject({
      ok: false,
      reason: 'ambiguous'
    })
    expect(resolvePick({ by: 'cheapest' }, [cards[2]])).toMatchObject({
      ok: false,
      reason: 'no-price'
    })
  })
})

describe('handleCardsTurn', () => {
  const NOW = 1_000_000
  let store: CardsStore
  const signal = new AbortController().signal

  type Deps = CardsTurnDeps & {
    openUrl: ReturnType<typeof vi.fn>
    saveNote: ReturnType<typeof vi.fn>
    openPanel: ReturnType<typeof vi.fn>
  }

  function setup(over: Partial<CardsTurnDeps> = {}, cards: AnswerCards = hotelCards()): Deps {
    store = new CardsStore(() => NOW)
    store.add('3 hotels in Nice', cards, { request: 'hotels in Nice for 3 to 5 May' })
    const d: Deps = {
      current: () => store.latest(),
      now: () => NOW + 60_000,
      webAt: () => 0,
      openUrl: vi.fn(async () => true),
      saveNote: vi.fn(async () => true),
      openPanel: vi.fn(),
      ...over
    }
    return d
  }

  afterEach(() => resetCardFocus())

  it('does nothing without fresh cards or when a web context is newer', async () => {
    expect(await handleCardsTurn('open it', signal, setup({ current: () => null }))).toBeNull()
    expect(
      await handleCardsTurn(
        'the second one',
        signal,
        setup({ now: () => NOW + FOLLOWUP_TTL_MS + 1 })
      )
    ).toBeNull()
    expect(
      await handleCardsTurn('open the second one', signal, setup({ webAt: () => NOW + 1 }))
    ).toBeNull()
    expect(await handleCardsTurn('what time is it', signal, setup())).toBeNull()
  })

  it('selects, then "open it" opens that card and keeps the strip', async () => {
    const d = setup()
    const sel = await handleCardsTurn('the cheapest', signal, d)
    expect(sel && 'response' in sel && sel.response.mode === 'answer' && sel.response.text).toBe(
      'The second one is Old Town Rooms, 95 euros a night, rated 8.1 out of 10. Parking: No.'
    )
    const r = await handleCardsTurn('open it', signal, d)
    expect(d.openUrl).toHaveBeenCalledWith('https://hotels.test/old-town')
    expect(r && 'response' in r && r.response.mode === 'answer' && r.response.text).toBe(
      'Opening Old Town Rooms.'
    )
    expect(cardsForAnswer('Opening Old Town Rooms.')).toBe(store.latest()!.id)
  })

  it('asks which one when "it" is unclear, and falls through for unknown names', async () => {
    const d = setup()
    const r = await handleCardsTurn('open it', signal, d)
    expect(r && 'response' in r && r.response.mode === 'answer' && r.response.text).toMatch(
      /^Which one: Hotel Azur, Old Town Rooms or Villa Cimiez\?$/
    )
    for (const t of [
      'open the blue car',
      'open notepad',
      'save the file',
      'open the settings',
      'open hotel paris'
    ])
      expect(await handleCardsTurn(t, signal, d)).toBeNull()
    const named = await handleCardsTurn('open villa cimiez', signal, d)
    expect(
      named && 'response' in named && named.response.mode === 'answer' && named.response.text
    ).toBe('Villa Cimiez has no link.')
    const out = await handleCardsTurn('open the ninth one', signal, d)
    expect(out && 'response' in out && out.response.mode === 'answer' && out.response.text).toBe(
      "I don't see that one. There are 3 results."
    )
  })

  it('"book the second one" starts the booking with the user words', async () => {
    const book = vi.fn(async () => ({ text: 'Booked Old Town Rooms. Reference AB12.' }))
    const d = setup({ book })
    const r = await handleCardsTurn('Book the second one', signal, d)
    expect(book).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Old Town Rooms' }),
      store.latest(),
      'Book the second one',
      signal
    )
    expect(r && 'response' in r && r.response.mode === 'answer' && r.response.text).toBe(
      'Booked Old Town Rooms. Reference AB12.'
    )
  })

  it('saves, compares and shows all', async () => {
    const d = setup()
    await handleCardsTurn('save the one near the sea', signal, d)
    expect(d.saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hotel Azur', url: 'https://hotels.test/azur' })
    )
    expect(d.saveNote.mock.calls[0][0].text).toContain('Price: 140 euros a night (3–5 May)')
    await handleCardsTurn('save them all', signal, d)
    expect(d.saveNote).toHaveBeenCalledTimes(4)
    await handleCardsTurn('compare them', signal, d)
    expect(d.openPanel).toHaveBeenLastCalledWith(`answer/${store.latest()!.id}/table`)
    await handleCardsTurn('show me all of them', signal, d)
    expect(d.openPanel).toHaveBeenLastCalledWith(`answer/${store.latest()!.id}`)
  })

  it('answers about a card from its page, or researches what the page does not say', async () => {
    const ask = vi.fn(async () => ({ found: true, answer: 'Yes, free private parking.' }))
    const d = setup({ ask })
    const r = await handleCardsTurn('the first one, does it have parking?', signal, d)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hotel Azur' }),
      'https://hotels.test/azur',
      'does it have parking',
      signal
    )
    expect(r && 'response' in r && r.response.mode === 'answer' && r.response.text).toBe(
      'Yes, free private parking.'
    )
    ask.mockResolvedValueOnce({ found: false, answer: 'The page does not say.' })
    const r2 = await handleCardsTurn('does it have a pool', signal, d)
    // "does it …" goes to the card picked last (Hotel Azur).
    expect(r2 && 'research' in r2 && r2.research).toBe(
      'About Hotel Azur (https://hotels.test/azur): does it have a pool Answer in one or two sentences with the source.'
    )
    resetCardFocus()
    expect(await handleCardsTurn('is it raining', signal, d)).toBeNull()
  })

  it('without a model, "tell me more" reads the card', async () => {
    const r = await handleCardsTurn('tell me more about the third one', signal, setup())
    expect(r && 'response' in r && r.response.mode === 'answer' && r.response.text).toBe(
      'The third one is Villa Cimiez. Area: Hills, 20 min to the beach.'
    )
  })

  it('"cheaper ones" and "more like this" re-run the research with a filter', async () => {
    const d = setup()
    const r = await handleCardsTurn('cheaper ones', signal, d)
    expect(r && 'research' in r && r.research).toBe(
      'hotels in Nice for 3 to 5 May. Only options cheaper than 95 euros a night (the cheapest found so far was Old Town Rooms).'
    )
    await handleCardsTurn('the first one', signal, d)
    const like = await handleCardsTurn('more like this', signal, d)
    expect(like && 'research' in like && like.research).toMatch(
      /^hotels in Nice for 3 to 5 May\. More options like Hotel Azur, Promenade des Anglais, Beach 2 min walk, Parking Yes, other than: Hotel Azur; Old Town Rooms; Villa Cimiez\.$/
    )
  })

  it('card text from pages never becomes the policy user words (research follow-ups)', async () => {
    const cards = hotelCards()
    const email = ['bookings', 'evil.example'].join('@')
    cards.cards[0].title = `Contact ${email}`
    const ask = vi.fn(async () => ({ found: false, answer: '' }))
    const d = setup({ ask }, cards)
    const r = await handleCardsTurn('the first one, does it have parking?', signal, d)
    if (!r || !('research' in r)) throw new Error('expected research')
    expect(r.research).toContain(email)
    expect(r.userText).toBe('the first one, does it have parking?')
    expect(r.userText).not.toContain(email)
    expect(r.observedText).toContain(email)
    resetCardFocus()
    const like = await handleCardsTurn('more like the first one', signal, d)
    if (!like || !('research' in like)) throw new Error('expected research')
    expect(like.userText).toBe('hotels in Nice for 3 to 5 May. more like the first one')
    expect(like.observedText).toContain(email)
  })
})
