import { afterEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../../src/main/bus'
import {
  cardAction,
  cardsView,
  currentCards,
  endCardsConversation,
  presentCards,
  setCardsPorts,
  type CardsPorts
} from '../../src/main/cards'
import { CardsStore, KEEP_SETS } from '../../src/main/cards/store'
import { hotelCards } from './fixture'

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

describe('presentCards', () => {
  it('stores valid cards, shows them and fills images in', async () => {
    const p = ports()
    const resolve = vi.fn(async () => 'data:image/jpeg;base64,AAAA')
    setCardsPorts(p, { resolve })
    const changed = new Promise<string>((done) => {
      const off = bus.on('cards.changed', (e) => {
        off()
        done(e.id)
      })
    })
    const r = presentCards('3 hotels in Nice', hotelCards())
    if (!r.ok) throw new Error(r.error)
    expect(p.showAnswer).toHaveBeenCalledWith('3 hotels in Nice', r.id)
    expect(cardsView(r.id)?.cards[0]).toMatchObject({ imagePending: true })
    expect(await changed).toBe(r.id)
    const view = cardsView(r.id)!
    expect(view.cards[0].image).toEqual({
      src: 'data:image/jpeg;base64,AAAA',
      alt: 'Hotel Azur seen from the sea'
    })
    // No remote URL reaches a view.
    expect(JSON.stringify(view)).not.toContain('img.hotels.test')
    expect(currentCards()?.id).toBe(r.id)
    endCardsConversation()
    expect(currentCards()).toBeNull()
    expect(cardsView(r.id)).not.toBeNull()
  })

  it('refuses invalid cards without showing anything', () => {
    const p = ports()
    setCardsPorts(p, { resolve: async () => null })
    const bad = hotelCards()
    bad.cards[0].price!.sourceId = 'gone'
    expect(presentCards('x', bad).ok).toBe(false)
    expect(p.showAnswer).not.toHaveBeenCalled()
  })

  it('a failed image leaves the card without one', async () => {
    setCardsPorts(ports(), { resolve: async () => null })
    const r = presentCards('x', hotelCards())
    if (!r.ok) throw new Error(r.error)
    await new Promise((d) => setTimeout(d, 0))
    const card = cardsView(r.id)!.cards[0]
    expect(card.image).toBeUndefined()
    expect(card.imagePending).toBeUndefined()
  })
})

describe('card actions', () => {
  async function shown(): Promise<{ id: string; p: ReturnType<typeof ports> }> {
    const p = ports()
    setCardsPorts(p, { resolve: async () => null })
    const r = presentCards('x', hotelCards())
    if (!r.ok) throw new Error(r.error)
    return { id: r.id, p }
  }

  it('opens the card link, saves a note, compares in the table', async () => {
    const { id, p } = await shown()
    expect(await cardAction({ id, cardId: 'h1', action: 'open' })).toEqual({ ok: true })
    expect(p.openUrl).toHaveBeenCalledWith('https://hotels.test/azur')
    const saved = await cardAction({ id, cardId: 'h1', action: 'save' })
    expect(saved).toEqual({ ok: true, message: 'Saved to your notes.' })
    expect(p.saveNote).toHaveBeenCalledWith({
      text: 'Hotel Azur\nPromenade des Anglais\nBeach: 2 min walk\nParking: Yes',
      title: 'Hotel Azur',
      url: 'https://hotels.test/azur'
    })
    await cardAction({ id, cardId: 'h2', action: 'compare' })
    expect(p.openPanel).toHaveBeenCalledWith(`answer/${id}/table`)
    await cardAction({ id, action: 'show-all' })
    expect(p.openPanel).toHaveBeenLastCalledWith(`answer/${id}`)
  })

  it('a card without links cannot open', async () => {
    const { id, p } = await shown()
    expect(await cardAction({ id, cardId: 'h3', action: 'open' })).toMatchObject({ ok: false })
    expect(p.openUrl).not.toHaveBeenCalled()
  })

  it('do emits cards.do (the booking starts there)', async () => {
    const { id, p } = await shown()
    const seen = vi.fn()
    const off = bus.on('cards.do', seen)
    const r = await cardAction({ id, cardId: 'h1', action: 'do' })
    off()
    expect(r).toEqual({ ok: true })
    expect(p.say).not.toHaveBeenCalled()
    expect(seen).toHaveBeenCalledWith({ type: 'cards.do', id, cardId: 'h1', label: 'Book it' })
  })

  it('unknown sets and cards are reported', async () => {
    const { id } = await shown()
    expect((await cardAction({ id: 'c_gone0000', action: 'show-all' })).ok).toBe(false)
    expect((await cardAction({ id, cardId: 'zz', action: 'open' })).ok).toBe(false)
  })
})

describe('cards store', () => {
  it('keeps the newest 10 sets', () => {
    const s = new CardsStore()
    const ids = Array.from({ length: KEEP_SETS + 2 }, () => s.add('x', hotelCards()).id)
    expect(s.get(ids[0])).toBeNull()
    expect(s.get(ids[2])).not.toBeNull()
    expect(s.inConversation()).toHaveLength(KEEP_SETS)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^c_[a-z0-9]{4,40}$/.test(id))).toBe(true)
  })
})
