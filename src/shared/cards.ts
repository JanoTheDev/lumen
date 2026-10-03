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
  'generic',
  // Answer-mode kinds (the model's own knowledge, no sources): a headline number, numbered
  // steps, a dated timeline, a tip / warning box, pros and cons, and a link worth opening.
  'stat',
  'steps',
  'timeline',
  'callout',
  'pros-cons',
  'link'
] as const
export type CardKind = (typeof CARD_KINDS)[number]

export const CARD_LAYOUTS = ['list', 'grid', 'table', 'carousel'] as const
export type CardLayout = (typeof CARD_LAYOUTS)[number]

/**
 * Card buttons. `link` opens its own https url, `ask` runs its label as the user's next
 * question (what the button says is what runs), `copy` copies the card's main text.
 */
export const CARD_ACTIONS = [
  'open',
  'save',
  'compare',
  'more',
  'do',
  'link',
  'ask',
  'copy'
] as const
export type CardActionKind = (typeof CARD_ACTIONS)[number]

/** Named accent colours; renderers map them to tuned values per theme. */
export const CARD_COLORS = [
  'blue',
  'indigo',
  'purple',
  'pink',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'gray'
] as const
export type CardColorName = (typeof CARD_COLORS)[number]
/** A named colour or a `#rrggbb` hex. */
export type CardColor = CardColorName | `#${string}`
export const CARD_HEX_RE = /^#[0-9a-fA-F]{6}$/

export const CARD_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
export type CardTone = (typeof CARD_TONES)[number]

export const BUTTON_STYLES = ['primary', 'secondary', 'plain'] as const
export type CardButtonStyle = (typeof BUTTON_STYLES)[number]

export const TRENDS = ['up', 'down', 'flat'] as const
export type CardTrend = (typeof TRENDS)[number]

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
  text: 2000,
  summary: 400,
  items: 8,
  item: 240,
  pros: 5,
  stat: 40
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

/** A short description from a reference page (an entity's Wikipedia summary). */
export interface CardSummary {
  text: string
  /** The page it is from (https). */
  url: string
  /** "Wikipedia". */
  source: string
}

export interface CardAction {
  kind: CardActionKind
  /** Button label ("Book it", "Buy it"); required for `do`, `link` and `ask`. */
  label?: string
  /** `link` only: the https page it opens. */
  url?: string
  /** How loud the button is; the card's first primary-able button is primary by default. */
  style?: CardButtonStyle
  /** Button colour (primary: its fill, else its text); the card's accent when absent. */
  color?: CardColor
}

/** A headline number ("18°C", "$1.2 bn") with what it means and how it moved. */
export interface CardValue {
  text: string
  caption?: string
  trend?: CardTrend
  /** "+2.4% today". */
  change?: string
}

/** One line of a steps / timeline / generic list ("2019" + "Founded in Berlin"). */
export interface CardItemLine {
  label?: string
  text: string
}

export interface Card {
  id: string
  kind: CardKind
  title: string
  subtitle?: string
  /** Entities: a few sentences from a reference page, with its link. */
  summary?: CardSummary
  image?: ImageRef
  price?: CardPrice
  rating?: CardRating
  facts: CardFact[]
  badges?: string[]
  links: CardLink[]
  actions: CardAction[]
  /** Colour of the card's accent line, numbers and default primary button. */
  accent?: CardColor
  /** callout: how it reads (tip, success, warning, problem). */
  tone?: CardTone
  /** stat: the headline number. */
  value?: CardValue
  /** steps / timeline / generic list lines. */
  items?: CardItemLine[]
  /** pros-cons. */
  pros?: string[]
  cons?: string[]
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
  /** Index of the button in the card's actions (several `link` / `ask` buttons). */
  index?: number
}

export interface CardActionResult {
  ok: boolean
  /** What happened, for the bar / a live region ("Saved to your notes."). */
  message?: string
}

/** Card set ids: `c_` + base36. */
export const CARDS_ID_RE = /^c_[a-z0-9]{4,40}$/
