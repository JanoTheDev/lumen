// Answer cards (05 Phase R): pure helpers for the bar strip and the panel page. Formatting,
// screen reader order, sorting, filter chips and the carousel window.
import type { CardFilter, CardPrice, CardRating, CardSource, CardView } from '@shared/cards'

/** Only local data URLs are drawn (the CSP would block anything else anyway). */
export const isDataImage = (src: string): boolean => /^data:image\/(jpeg|png);base64,/.test(src)

export type CardSort = 'relevance' | 'price' | 'rating'

/** "€120 a night" (the currency's own symbol where Intl knows it). */
export function formatPrice(p: CardPrice): string {
  let amount: string
  try {
    amount = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: p.currency,
      maximumFractionDigits: Number.isInteger(p.amount) ? 0 : 2
    }).format(p.amount)
  } catch {
    amount = `${p.amount} ${p.currency}`
  }
  return p.unit ? `${amount} a ${p.unit}` : amount
}

const trimNum = (n: number): string => String(Math.round(n * 10) / 10)

/** "4.5 out of 5 (1,203 reviews)". */
export function formatRating(r: CardRating): string {
  const count =
    r.count !== undefined
      ? ` (${r.count.toLocaleString('en')} review${r.count === 1 ? '' : 's'})`
      : ''
  return `${trimNum(r.value)} out of ${trimNum(r.max)}${count}`
}

/** "2 h ago" style age of a check; '' for 0. */
export function checkedAgo(at: number, now: number): string {
  if (!at) return ''
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export function sourceOf(sources: CardSource[], id?: string): CardSource | undefined {
  return id ? sources.find((s) => s.id === id) : undefined
}

/** The card's main source: the price's, else the rating's. */
export function mainSource(card: CardView, sources: CardSource[]): CardSource | undefined {
  return sourceOf(sources, card.price?.sourceId) ?? sourceOf(sources, card.rating?.sourceId)
}

/** "From Booking.com, checked 2 h ago". */
export function sourceLine(src: CardSource, now: number): string {
  const ago = checkedAgo(src.checkedAt, now)
  return `From ${src.title}${ago ? `, checked ${ago}` : ''}`
}

/** What a screen reader (or simple mode's Read) says, in order: title, price, rating, facts, source. */
export function readOrder(card: CardView, sources: CardSource[], now: number): string[] {
  const out = [card.subtitle ? `${card.title}, ${card.subtitle}` : card.title]
  if (card.price)
    out.push(`Price ${formatPrice(card.price)}${card.price.note ? `, ${card.price.note}` : ''}`)
  if (card.rating) out.push(`Rated ${formatRating(card.rating)}`)
  for (const f of card.facts) out.push(`${f.label}: ${f.value}`)
  if (card.badges?.length) out.push(card.badges.join(', '))
  const src = mainSource(card, sources)
  if (src) out.push(sourceLine(src, now))
  return out
}

const ratingScore = (r?: CardRating): number => (r ? r.value / r.max : -1)

/** A sorted copy; cards without the field go last, ties keep the model's order. */
export function sortCards(cards: CardView[], by: CardSort): CardView[] {
  if (by === 'relevance') return cards.slice()
  const indexed = cards.map((c, i) => ({ c, i }))
  indexed.sort((a, b) => {
    if (by === 'price') {
      const pa = a.c.price?.amount ?? Infinity
      const pb = b.c.price?.amount ?? Infinity
      return pa === pb ? a.i - b.i : pa - pb
    }
    const d = ratingScore(b.c.rating) - ratingScore(a.c.rating)
    return d === 0 ? a.i - b.i : d
  })
  return indexed.map((x) => x.c)
}

/** A filter chip matches a badge, fact, subtitle or title (case-insensitive substring). */
export function matchesFilter(card: CardView, f: CardFilter): boolean {
  const needle = f.match.toLowerCase()
  const hay = [
    card.title,
    card.subtitle ?? '',
    ...(card.badges ?? []),
    ...card.facts.map((x) => `${x.label} ${x.value}`)
  ]
  return hay.some((h) => h.toLowerCase().includes(needle))
}

/** Cards matching every active chip. */
export function filterCards(cards: CardView[], active: CardFilter[]): CardView[] {
  return active.length ? cards.filter((c) => active.every((f) => matchesFilter(c, f))) : cards
}

/** First index of the carousel window that shows `focus` (at most `visible` cards at once). */
export function windowStart(start: number, focus: number, total: number, visible = 3): number {
  const max = Math.max(0, total - visible)
  let s = Math.min(Math.max(0, start), max)
  if (focus < s) s = focus
  else if (focus >= s + visible) s = focus - visible + 1
  return Math.min(Math.max(0, s), max)
}

/** Table columns: every fact label in first-seen order (at most 6). */
export function factColumns(cards: CardView[]): string[] {
  const out: string[] = []
  for (const c of cards)
    for (const f of c.facts) if (!out.includes(f.label) && out.length < 6) out.push(f.label)
  return out
}

export function factValue(card: CardView, label: string): string {
  return card.facts.find((f) => f.label === label)?.value ?? ''
}
