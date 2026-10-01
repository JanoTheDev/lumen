// Answer cards (05 Phase R): validate, keep per conversation, show under the bar's answer,
// resolve images in the background, and run the card buttons. The ports keep this testable;
// `installCards` wires the real ones (bar, panel, executor, notes, announce).
import type { AnswerCards, CardActionRequest, CardActionResult, CardsView } from '@shared/cards'
import { bus } from '../bus'
import { log } from '../logger'
import { cardImages, type CardImages } from './images'
import { validateCards } from './schema'
import { CardsStore, type StoredCards } from './store'

export { validateCards } from './schema'
export type { StoredCards } from './store'

export interface CardsPorts {
  /** Shows the answer text with its card strip on the bar. */
  showAnswer(text: string, cardsId: string): void
  /** Opens a https link in the user's browser (open_url, origin user-direct). */
  openUrl(url: string): Promise<boolean>
  saveNote(note: { text: string; title?: string; url?: string }): Promise<boolean>
  /** Opens the panel window at a route ("answer/<id>"). */
  openPanel(route: string): void
  /** Runs a typed request through the pipeline as if the user said it. */
  runQuery(text: string): void
  /** One short spoken / announced line. */
  say(text: string): void
}

let ports: CardsPorts | null = null
let images: Pick<CardImages, 'resolve'> = cardImages
export const store = new CardsStore()

export function setCardsPorts(
  p: CardsPorts | null,
  img: Pick<CardImages, 'resolve'> = cardImages
): void {
  ports = p
  images = img
}

export type PresentResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Shows `text` with cards on the bar. Invalid cards are refused (the caller shows the text
 * alone); images load afterwards and the views are refreshed through `cards.changed`.
 */
export function presentCards(text: string, raw: unknown): PresentResult {
  const check = validateCards(raw)
  if (!check.ok) {
    log('fail', `cards refused: ${check.error}`)
    return { ok: false, error: check.error }
  }
  const set = store.add(text, check.cards)
  ports?.showAnswer(text, set.id)
  void loadImages(set)
  return { ok: true, id: set.id }
}

async function loadImages(set: StoredCards): Promise<void> {
  await Promise.all(
    set.cards.cards.map(async (card) => {
      if (!card.image) return
      const ref = card.image
      const src = await images.resolve(ref.sourceUrl).catch(() => null)
      const image = src
        ? { src, alt: ref.alt, ...(ref.attribution ? { attribution: ref.attribution } : {}) }
        : null
      if (store.setImage(set.id, card.id, image)) bus.emit({ type: 'cards.changed', id: set.id })
    })
  )
}

export function cardsView(id: string): CardsView | null {
  return store.view(id)
}

/** The newest card set of this conversation, for follow-ups ("the second one", T40). */
export function currentCards(): StoredCards | null {
  return store.latest()
}

export function endCardsConversation(): void {
  store.endConversation()
}

const sourceUrl = (cards: AnswerCards, id?: string): string | undefined =>
  id ? cards.sources.find((s) => s.id === id)?.url : undefined

export async function cardAction(req: CardActionRequest): Promise<CardActionResult> {
  const set = store.get(req.id)
  if (!set) return { ok: false, message: 'Those results are gone. Ask again to see them.' }
  if (!ports) return { ok: false, message: 'Not ready yet.' }
  if (req.action === 'show-all' || req.action === 'compare') {
    ports.openPanel(`answer/${set.id}${req.action === 'compare' ? '/table' : ''}`)
    return { ok: true }
  }
  const card = set.cards.cards.find((c) => c.id === req.cardId)
  if (!card) return { ok: false, message: 'That card is gone.' }
  const link =
    card.links[0]?.url ?? sourceUrl(set.cards, card.price?.sourceId ?? card.rating?.sourceId)
  switch (req.action) {
    case 'open': {
      if (!link) return { ok: false, message: 'This card has no link.' }
      const ok = await ports.openUrl(link)
      return ok ? { ok } : { ok, message: 'I could not open that link.' }
    }
    case 'save': {
      const lines = [card.title, card.subtitle, ...card.facts.map((f) => `${f.label}: ${f.value}`)]
      const ok = await ports
        .saveNote({ text: lines.filter(Boolean).join('\n'), title: card.title, url: link })
        .catch(() => false)
      const message = ok ? 'Saved to your notes.' : 'Notes are not available.'
      ports.say(message)
      return { ok, message }
    }
    case 'more':
      ports.runQuery(`Tell me more about ${card.title}`)
      return { ok: true }
    case 'do': {
      // Booking runs as an agent task in the user's browser (T41); until then it only says so.
      const label = card.actions.find((a) => a.kind === 'do')?.label ?? 'Do it'
      bus.emit({ type: 'cards.do', id: set.id, cardId: card.id, label })
      const message = "Booking isn't ready yet."
      ports.say(message)
      return { ok: false, message }
    }
  }
  return { ok: false }
}
