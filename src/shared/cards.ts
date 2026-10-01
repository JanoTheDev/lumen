// Rich answer cards (05 Phase R): typed data the model fills; Lumen's renderer owns the layout.
// No HTML, no markdown images, no remote URLs reach a renderer: images arrive as data URLs.
// Pure TS (zod-free); the strict validator lives in main (`cards/schema`).

export const CARD_KINDS = [
  'place',
  'lodging',
  'product',
  'trip',
  'recipe',
  'entity',
  'generic'
] as const
export type CardKind = (typeof CARD_KINDS)[number]

export const CARD_LAYOUTS = ['list', 'grid', 'table', 'carousel'] as const
export type CardLayout = (typeof CARD_LAYOUTS)[number]

export const CARD_ACTIONS = ['open', 'save', 'compare', 'more', 'do'] as const
export type CardActionKind = (typeof CARD_ACTIONS)[number]

/** Caps the validator enforces (and the renderer may rely on). */
export const CARD_LIMITS = {
  cards: 12,
  facts: 6,
  badges: 3,
  links: 4,
  actions: 5,
  sources: 24,
  filters: 8,
  title: 120,
  subtitle: 160,
  label: 40,
  value: 160,
  note: 120,
  alt: 200,
  url: 2048,
  text: 2000
} as const

/** Where a fact came from: a page that was fetched or read, with the time it was checked. */
export interface CardSource {
  id: string
  title: string
  /** https only. */
  url: string
  /** When the page was read, ms since epoch. */
  checkedAt: number
}

/** A remote picture; main fetches it and hands renderers a data URL instead. */
export interface ImageRef {
  /** The image file (https). */
  sourceUrl: string
  /** The page it was on (https). */
  pageUrl: string
  alt: string
  /** Credit line, e.g. "Photo: Jane Doe, CC BY-SA 4.0, Wikimedia Commons". */
  attribution?: string
}

export interface CardPrice {
  amount: number
  /** ISO 4217, e.g. EUR. */
  currency: string
  /** "night", "person". */
  unit?: string
  /** "from booking.com, 3–5 May, may change". */
  note?: string
  sourceId: string
}

export interface CardRating {
  value: number
  max: number
  count?: number
  sourceId: string
}

export interface CardFact {
  label: string
  value: string
}

export interface CardLink {
  label: string
  /** https only. */
  url: string
}

export interface CardAction {
  kind: CardActionKind
  /** Button label ("Book it", "Buy it"); required for `do`. */
  label?: string
}

export interface Card {
  id: string
  kind: CardKind
  title: string
  subtitle?: string
  image?: ImageRef
  price?: CardPrice
  rating?: CardRating
  facts: CardFact[]
  badges?: string[]
  links: CardLink[]
  actions: CardAction[]
}

/** A filter chip the model suggested: a card matches when a badge, fact or subtitle says it. */
export interface CardFilter {
  label: string
  match: string
}

export interface AnswerCards {
  layout: CardLayout
  cards: Card[]
  sources: CardSource[]
  filters?: CardFilter[]
}

/** A resolved card image (data URL only). */
export interface CardImage {
  src: string
  alt: string
  attribution?: string
}

/** One card as renderers get it: the remote image replaced by a resolved one (or none). */
export type CardView = Omit<Card, 'image'> & {
  image?: CardImage
  /** True while main is still fetching the image. */
  imagePending?: boolean
}

/** A stored card set (`cards:get`). */
export interface CardsView {
  id: string
  /** The short answer text the cards belong to. */
  text: string
  layout: CardLayout
  cards: CardView[]
  sources: CardSource[]
  filters: CardFilter[]
  createdAt: number
}

/** `cards:action`: a card's button, or the strip's Show all. */
export interface CardActionRequest {
  id: string
  cardId?: string
  action: CardActionKind | 'show-all'
}

export interface CardActionResult {
  ok: boolean
  /** What happened, for the bar / a live region ("Saved to your notes."). */
  message?: string
}

/** Card set ids: `c_` + base36. */
export const CARDS_ID_RE = /^c_[a-z0-9]{4,40}$/
