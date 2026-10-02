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

/**
 * What a screen reader (or simple mode's Read) says, in order: title, the kind's key line,
 * price, rating, summary, facts, source.
 */
export function readOrder(card: CardView, sources: CardSource[], now: number): string[] {
  const out = [card.subtitle ? `${card.title}, ${card.subtitle}` : card.title]
  const line = keyLine(card)
  if (line.items.length) out.push(line.items.join(', '))
  if (card.price)
    out.push(`Price ${formatPrice(card.price)}${card.price.note ? `, ${card.price.note}` : ''}`)
  if (card.rating) out.push(`Rated ${formatRating(card.rating)}`)
  if (card.summary) out.push(`${card.summary.text} From ${card.summary.source}`)
  for (const f of restFacts(card, line)) out.push(`${f.label}: ${f.value}`)
  if (card.badges?.length) out.push(card.badges.join(', '))
  const src = mainSource(card, sources)
  if (src) out.push(sourceLine(src, now))
  return out
}

const ratingScore = (r?: CardRating): number => (r ? r.value / r.max : -1)

/** The currency most priced cards use (ties: the one seen first), or null. */
export function mainCurrency(cards: readonly CardView[]): string | null {
  const count = new Map<string, number>()
  for (const c of cards)
    if (c.price) count.set(c.price.currency, (count.get(c.price.currency) ?? 0) + 1)
  let best: string | null = null
  for (const [cur, n] of count) if (best === null || n > count.get(best)!) best = cur
  return best
}

/**
 * A sorted copy; cards without the field go last, ties keep the model's order. By price: the
 * most common currency first (amounts in other currencies are not compared with it).
 */
export function sortCards(cards: CardView[], by: CardSort): CardView[] {
  if (by === 'relevance') return cards.slice()
  const indexed = cards.map((c, i) => ({ c, i }))
  const cur = by === 'price' ? mainCurrency(cards) : null
  const group = (c: CardView): number => (!c.price ? 2 : c.price.currency === cur ? 0 : 1)
  indexed.sort((a, b) => {
    if (by === 'price') {
      const g = group(a.c) - group(b.c)
      if (g) return g
      // Other currencies: each one's cards together, in alphabetical order of the code.
      if (group(a.c) === 1 && a.c.price!.currency !== b.c.price!.currency)
        return a.c.price!.currency < b.c.price!.currency ? -1 : 1
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

// ---- per-kind key line (T42) ----

const RECIPE_TIME =
  /^(?:(?:total|prep|preparation|cook|cooking) )?time$|^(?:duration|ready in|takes)$/i
const RECIPE_SERVES = /^(?:servings?|serves|yield|portions?|makes)$/i
const PRODUCT_STORE = /^(?:store|shop|seller|sold by|retailer)$/i
const PRODUCT_STOCK = /^(?:availability|stock|in stock)$/i
const TRIP_DEPART = /^(?:departs?|departure|leaves?|dep\.?)$/i
const TRIP_ARRIVE = /^(?:arrives?|arrival|arr\.?)$/i
const TRIP_DURATION = /^(?:duration|travel time|journey time|takes)$/i
const TRIP_CHANGES = /^(?:changes|transfers|stops|connections)$/i

export interface KeyLine {
  /** Short pieces shown on one line ("35 min", "Serves 4"). */
  items: string[]
  /** Fact labels the line already says (left out of the fact list). */
  used: string[]
}

const findFact = (card: CardView, re: RegExp): CardView['facts'][number] | undefined =>
  card.facts.find((f) => re.test(f.label.trim()))

/**
 * The line a card's kind puts first: recipes their time and servings, products the store and
 * stock, trips their times, changes and duration. Built from the card's own facts only (the
 * price's source line already names where a price is from).
 */
export function keyLine(card: CardView): KeyLine {
  const items: string[] = []
  const used: string[] = []
  const take = (re: RegExp): string | undefined => {
    const f = findFact(card, re)
    if (!f) return undefined
    used.push(f.label)
    return f.value
  }
  switch (card.kind) {
    case 'recipe': {
      const time = take(RECIPE_TIME)
      if (time) items.push(time)
      const serves = take(RECIPE_SERVES)
      if (serves) items.push(/^\d+$/.test(serves) ? `Serves ${serves}` : serves)
      break
    }
    case 'product': {
      const store = take(PRODUCT_STORE)
      if (store) items.push(`At ${store}`)
      const stock = take(PRODUCT_STOCK)
      if (stock) items.push(stock)
      break
    }
    case 'trip': {
      const dep = take(TRIP_DEPART)
      const arr = take(TRIP_ARRIVE)
      if (dep && arr) items.push(`${dep} → ${arr}`)
      else if (dep) items.push(`Leaves ${dep}`)
      else if (arr) items.push(`Arrives ${arr}`)
      const dur = take(TRIP_DURATION)
      if (dur) items.push(dur)
      const ch = take(TRIP_CHANGES)
      if (ch)
        items.push(
          /^0$/.test(ch) ? 'Direct' : /^\d+$/.test(ch) ? `${ch} change${ch === '1' ? '' : 's'}` : ch
        )
      break
    }
  }
  return { items, used }
}

/** The facts left for the list once the key line has said some. */
export function restFacts(card: CardView, line: KeyLine): CardView['facts'] {
  return line.used.length ? card.facts.filter((f) => !line.used.includes(f.label)) : card.facts
}

/** For the comparison table: the cheapest card (one currency) and the best rated one. */
export function bestIds(cards: CardView[]): { cheapest?: string; best?: string } {
  const out: { cheapest?: string; best?: string } = {}
  const priced = cards.filter((c) => c.price)
  if (priced.length > 1) {
    const cur = mainCurrency(priced)
    const same = priced.filter((c) => c.price!.currency === cur)
    if (same.length > 1)
      out.cheapest = same.reduce((a, b) => (b.price!.amount < a.price!.amount ? b : a)).id
  }
  const rated = cards.filter((c) => c.rating)
  if (rated.length > 1)
    out.best = rated.reduce((a, b) => (ratingScore(b.rating) > ratingScore(a.rating) ? b : a)).id
  return out
}
