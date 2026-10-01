// Card sets shown in this conversation (05 T37). The newest 10 stay readable by id for the
// panel's #/answer/<id>; follow-ups ("the second one", T40) see only the current conversation.
// Remote image refs stay here; views carry resolved data URLs only. Pure.
import type { AnswerCards, CardImage, CardView, CardsView } from '@shared/cards'

export const KEEP_SETS = 10

export interface StoredCards {
  id: string
  text: string
  cards: AnswerCards
  /** Per card id: the resolved image, null (failed / none) or 'pending'. */
  images: Map<string, CardImage | null | 'pending'>
  createdAt: number
  /** The request the cards answer (follow-ups re-run it with a filter, T40). */
  request?: string
}

export class CardsStore {
  private readonly sets = new Map<string, StoredCards>()
  private conversation: string[] = []
  private seq = 0

  constructor(private readonly now: () => number = Date.now) {}

  private newId(): string {
    const stamp = this.now().toString(36)
    const rand = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0')
    return `c_${stamp}${(++this.seq).toString(36)}${rand}`
  }

  /** `conversation: false`: kept by id only (a background task's results), no follow-ups. */
  add(
    text: string,
    cards: AnswerCards,
    opts: { request?: string; conversation?: boolean } = {}
  ): StoredCards {
    const images = new Map<string, CardImage | null | 'pending'>()
    for (const c of cards.cards) images.set(c.id, c.image ? 'pending' : null)
    const set: StoredCards = { id: this.newId(), text, cards, images, createdAt: this.now() }
    if (opts.request) set.request = opts.request
    this.sets.set(set.id, set)
    if (opts.conversation !== false) this.conversation.push(set.id)
    while (this.sets.size > KEEP_SETS) {
      const oldest = this.sets.keys().next().value
      if (oldest === undefined) break
      this.sets.delete(oldest)
      this.conversation = this.conversation.filter((id) => id !== oldest)
    }
    return set
  }

  get(id: string): StoredCards | null {
    return this.sets.get(id) ?? null
  }

  /** A picture is being looked up for a card that had none (shown as pending). */
  markPending(id: string, cardId: string): boolean {
    const set = this.sets.get(id)
    if (!set || set.images.get(cardId) !== null) return false
    set.images.set(cardId, 'pending')
    return true
  }

  setImage(id: string, cardId: string, image: CardImage | null): boolean {
    const set = this.sets.get(id)
    if (!set || !set.images.has(cardId)) return false
    set.images.set(cardId, image)
    return true
  }

  /** The newest card set of the current conversation (follow-ups, T40). */
  latest(): StoredCards | null {
    const id = this.conversation[this.conversation.length - 1]
    return id ? (this.sets.get(id) ?? null) : null
  }

  /** Every card set of the current conversation, oldest first. */
  inConversation(): StoredCards[] {
    return this.conversation.flatMap((id) => this.sets.get(id) ?? [])
  }

  /** The conversation ended: follow-ups no longer see its cards (open panels still do). */
  endConversation(): void {
    this.conversation = []
  }

  view(id: string): CardsView | null {
    const set = this.sets.get(id)
    return set ? toView(set) : null
  }
}

export function toView(set: StoredCards): CardsView {
  return {
    id: set.id,
    text: set.text,
    layout: set.cards.layout,
    sources: set.cards.sources,
    filters: set.cards.filters ?? [],
    createdAt: set.createdAt,
    cards: set.cards.cards.map((c): CardView => {
      const card: CardView = { ...c, image: undefined }
      delete card.image
      const img = set.images.get(c.id)
      if (img === 'pending') return { ...card, imagePending: true }
      return img ? { ...card, image: img } : card
    })
  }
}
