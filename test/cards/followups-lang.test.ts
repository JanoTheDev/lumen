// Card follow-ups in Dutch, German, French and Spanish (05 T42): ordinals, last, cheapest and
// best rated, with an optional open / save / book / tell-me-more verb, only for those voice
// languages.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { foreignCardPhrase, parseCardIntent } from '../../src/main/cards/followups'
import { CardsStore } from '../../src/main/cards/store'
import { handleCardsTurn, resetCardFocus } from '../../src/main/cards/turn'
import { hotelCards } from './fixture'

describe('foreignCardPhrase', () => {
  it.each([
    ['nl', 'de tweede', 'the second one'],
    ['nl', 'het derde hotel', 'the third one'],
    ['nl', 'open de goedkoopste', 'open the cheapest one'],
    ['nl', 'de laatste', 'the last one'],
    ['nl', 'bewaar de eerste', 'save the first one'],
    ['nl', 'vertel me meer over de tweede optie', 'tell me more about the second one'],
    ['de', 'die zweite', 'the second one'],
    ['de', 'den zweiten', 'the second one'],
    ['de', 'öffne das günstigste hotel', 'open the cheapest one'],
    ['de', 'die billigste', 'the cheapest one'],
    ['de', 'buche die erste', 'book the first one'],
    ['de', 'die best bewertete', 'the best rated one'],
    ['fr', 'le deuxième', 'the second one'],
    ['fr', 'la seconde option', 'the second one'],
    ['fr', 'ouvre le moins cher', 'open the cheapest one'],
    ['fr', 'la moins chère', 'the cheapest one'],
    ['fr', 'le dernier', 'the last one'],
    ['fr', "l'hôtel le moins cher", null],
    ['es', 'el segundo', 'the second one'],
    ['es', 'la segunda opción', 'the second one'],
    ['es', 'abre el más barato', 'open the cheapest one'],
    ['es', 'reserva el primero', 'book the first one'],
    ['es', 'el último', 'the last one'],
    ['nl', 'open kladblok', null],
    ['de', 'wie spät ist es', null],
    ['en', 'de tweede', null],
    ['it', 'il secondo', null]
  ])('%s: %s', (lang, text, en) => expect(foreignCardPhrase(text, lang)).toBe(en))

  it('every English phrase it makes is a card intent', () => {
    for (const [lang, text] of [
      ['nl', 'de tweede'],
      ['de', 'öffne die zweite'],
      ['fr', 'le moins cher'],
      ['es', 'reserva el primero']
    ])
      expect(parseCardIntent(foreignCardPhrase(text, lang)!)).not.toBeNull()
  })
})

describe('handleCardsTurn in another language', () => {
  afterEach(() => resetCardFocus())
  const NOW = 1_000_000

  const setup = (
    lang: string
  ): Parameters<typeof handleCardsTurn>[2] & {
    openUrl: ReturnType<typeof vi.fn>
  } => {
    const store = new CardsStore(() => NOW)
    store.add('3 hotels', hotelCards())
    return {
      current: () => store.latest(),
      now: () => NOW + 1000,
      webAt: () => 0,
      openUrl: vi.fn(async () => true),
      saveNote: vi.fn(async () => true),
      openPanel: vi.fn(),
      lang: () => lang
    }
  }

  it('"open de goedkoopste" opens the cheapest card for a Dutch speaker', async () => {
    const d = setup('nl')
    const r = await handleCardsTurn('open de goedkoopste', new AbortController().signal, d)
    expect(r).not.toBeNull()
    expect(d.openUrl).toHaveBeenCalledWith('https://hotels.test/old-town')
  })

  it('"el segundo" selects the second card for a Spanish speaker', async () => {
    const r = await handleCardsTurn('el segundo', new AbortController().signal, setup('es'))
    expect(r && 'response' in r && r.response.text).toMatch(/^The second one is Old Town Rooms/)
  })

  it('English speakers do not get the other languages', async () => {
    expect(
      await handleCardsTurn('die zweite', new AbortController().signal, setup('en'))
    ).toBeNull()
  })
})
