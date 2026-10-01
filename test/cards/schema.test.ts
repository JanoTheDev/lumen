import { describe, expect, it } from 'vitest'
import { validateCards } from '../../src/main/cards/schema'
import type { AnswerCards } from '../../src/shared/cards'
import { hotelCards } from './fixture'

const edit = (fn: (c: AnswerCards) => void): AnswerCards => {
  const c = hotelCards()
  fn(c)
  return c
}

describe('answer card schema', () => {
  it('accepts the fixture', () => {
    const r = validateCards(hotelCards())
    expect(r.ok).toBe(true)
  })

  it('refuses non-https and private links and images', () => {
    expect(validateCards(edit((c) => (c.cards[0].links[0].url = 'http://hotels.test/a'))).ok).toBe(
      false
    )
    expect(validateCards(edit((c) => (c.sources[0].url = 'https://localhost/x'))).ok).toBe(false)
    expect(
      validateCards(edit((c) => (c.cards[0].image!.sourceUrl = 'https://192.168.1.4/a.jpg'))).ok
    ).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].links[0].url = 'javascript:alert(1)'))).ok).toBe(
      false
    )
  })

  it('caps cards, facts, badges and text lengths', () => {
    const many = edit((c) => {
      c.cards = Array.from({ length: 13 }, (_, i) => ({ ...c.cards[2], id: `x${i}` }))
    })
    expect(validateCards(many).ok).toBe(false)
    const facts = edit((c) => {
      c.cards[0].facts = Array.from({ length: 7 }, (_, i) => ({ label: `f${i}`, value: 'v' }))
    })
    expect(validateCards(facts).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].badges = ['a', 'b', 'c', 'd']))).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].title = 'x'.repeat(121)))).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards = []))).ok).toBe(false)
  })

  it('needs price and rating sources that exist', () => {
    const r = validateCards(edit((c) => (c.cards[1].price!.sourceId = 'nope')))
    expect(r).toEqual({ ok: false, error: 'cards.1.price.sourceId: price names an unknown source' })
    expect(validateCards(edit((c) => (c.cards[0].rating!.sourceId = 's9'))).ok).toBe(false)
  })

  it('is strict about keys, ids, labels and values', () => {
    expect(validateCards({ ...hotelCards(), html: '<b>x</b>' }).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[1].id = c.cards[0].id))).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].actions = [{ kind: 'do' }]))).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].rating!.value = 6))).ok).toBe(false)
    expect(validateCards(edit((c) => (c.cards[0].price!.currency = 'euro'))).ok).toBe(false)
  })
})
