// Cards in a plain answer: the model may end its markdown with one fenced ```cards block of
// JSON (stat, steps, timeline, callout, pros-cons, link and the research kinds). The reply schema
// has no room for another optional object (Anthropic's strict optional budget), so the cards ride
// in the markdown string, are cut out here, and go through the same strict validator as research
// cards. They come from the model's own knowledge: no sources, so never a price, rating or
// picture. Every field is cut to its cap; a card that still fails validation is left out. Pure.
import {
  BUTTON_STYLES,
  CARD_COLORS,
  CARD_HEX_RE,
  CARD_KINDS,
  CARD_LIMITS as L,
  CARD_TONES,
  TRENDS,
  type AnswerCards,
  type Card,
  type CardAction,
  type CardColor,
  type CardItemLine,
  type CardLayout
} from '@shared/cards'
import { isPrivateHost } from '../web/net'
import { validateCards } from './schema'

const FENCE_RE = /```cards[^\S\n]*\n([\s\S]*?)(?:```|$)/g

/** The most cards one answer shows (research results can have 12). */
export const ANSWER_CARDS_MAX = 6
const BUTTONS_MAX = 3

export interface ExtractedCards {
  /** The markdown without the cards block, trimmed ('' when only cards were there). */
  markdown: string
  /** Valid cards, or undefined when there was no usable block. */
  cards?: AnswerCards
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown, max: number): string =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim().slice(0, max).trim()
    : ''

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T)
    : undefined

/** A named card colour or #rrggbb from model text; undefined for anything else. */
export function cardColor(v: unknown): CardColor | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (CARD_HEX_RE.test(s)) return s.toLowerCase() as CardColor
  return oneOf(CARD_COLORS, s)
}

function https(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > L.url) return undefined
  try {
    const u = new URL(v.trim())
    if (u.protocol !== 'https:' || u.username || u.password || isPrivateHost(u.hostname))
      return undefined
    return u.href
  } catch {
    return undefined
  }
}

const strings = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, len))
        .filter(Boolean)
        .slice(0, max)
    : []

function items(v: unknown): CardItemLine[] {
  if (!Array.isArray(v)) return []
  const out: CardItemLine[] = []
  for (const x of v) {
    if (out.length >= L.items) break
    if (isObj(x)) {
      const text = str(x.text ?? x.value, L.item)
      const label = str(x.label ?? x.title ?? x.time, L.label)
      if (text) out.push(label ? { label, text } : { text })
      else if (label) out.push({ text: label })
    } else {
      const text = str(x, L.item)
      if (text) out.push({ text })
    }
  }
  return out
}

/** Facts as `[{label, value}]` or `{label: value}`. */
function facts(v: unknown): Card['facts'] {
  const pairs: [unknown, unknown][] = Array.isArray(v)
    ? v.filter(isObj).map((f) => [f.label, f.value])
    : isObj(v)
      ? Object.entries(v)
      : []
  return pairs
    .map(([l, val]) => ({ label: str(l, L.label), value: str(val, L.value) }))
    .filter((f) => f.label && f.value)
    .slice(0, L.facts)
}

function buttons(v: unknown, link: string | undefined): CardAction[] {
  const out: CardAction[] = []
  for (const b of Array.isArray(v) ? v : []) {
    if (out.length >= BUTTONS_MAX || !isObj(b)) continue
    const label = str(b.label, L.label)
    if (!label) continue
    const url = https(b.url)
    const kind = oneOf(['link', 'ask', 'copy'] as const, b.action) ?? (url ? 'link' : 'ask')
    if (kind === 'link' && !url) continue
    const a: CardAction = { kind, label }
    if (kind === 'link') a.url = url
    const style = oneOf(BUTTON_STYLES, b.style)
    if (style) a.style = style
    const c = cardColor(b.color)
    if (c) a.color = c
    out.push(a)
  }
  // A card with a link and no button for it opens from an Open button.
  if (link && !out.some((a) => a.kind === 'link' && a.url === link))
    out.unshift({ kind: 'open', label: 'Open' })
  return out.slice(0, L.actions)
}

function card(raw: unknown, i: number): Card | null {
  if (!isObj(raw)) return null
  const kind = oneOf(CARD_KINDS, raw.kind) ?? 'generic'
  const title = str(raw.title, L.title)
  if (!title) return null
  const c: Card = { id: `a${i + 1}`, kind, title, facts: facts(raw.facts), links: [], actions: [] }
  const subtitle = str(raw.subtitle, L.subtitle)
  if (subtitle) c.subtitle = subtitle
  const link = https(raw.link ?? raw.url)
  if (link) c.links.push({ label: new URL(link).hostname.replace(/^www\./, ''), url: link })
  c.actions = buttons(raw.buttons, link)
  const accent = cardColor(raw.accent ?? raw.color)
  if (accent) c.accent = accent
  const tone = oneOf(CARD_TONES, raw.tone)
  if (tone) c.tone = tone
  const value = isObj(raw.value) ? raw.value : raw.value !== undefined ? { text: raw.value } : null
  if (value) {
    const text = str(value.text, L.stat)
    if (text) {
      c.value = { text }
      const caption = str(value.caption, L.label)
      if (caption) c.value.caption = caption
      const trend = oneOf(TRENDS, value.trend)
      if (trend) c.value.trend = trend
      const change = str(value.change, L.label)
      if (change) c.value.change = change
    }
  }
  const lines = items(raw.items ?? raw.steps)
  if (lines.length) c.items = lines
  const pros = strings(raw.pros, L.pros, L.item)
  if (pros.length) c.pros = pros
  const cons = strings(raw.cons, L.pros, L.item)
  if (cons.length) c.cons = cons
  const badges = strings(raw.badges, L.badges, L.label)
  if (badges.length) c.badges = badges
  return c
}

const LAYOUTS: readonly CardLayout[] = ['carousel', 'grid', 'table', 'list']

/** Builds valid cards from the model's JSON; null when none survive. */
export function buildModelCards(raw: unknown): AnswerCards | null {
  const list = isObj(raw) ? raw.cards : raw
  if (!Array.isArray(list)) return null
  const layout = (isObj(raw) && oneOf(LAYOUTS, raw.layout)) || 'carousel'
  const cards = list
    .slice(0, ANSWER_CARDS_MAX)
    .map(card)
    .filter((c): c is Card => !!c)
    .filter((c) => validateCards({ layout, cards: [c], sources: [] }).ok)
  if (!cards.length) return null
  const set: AnswerCards = { layout, cards, sources: [] }
  return validateCards(set).ok ? set : null
}

/** Cuts every ```cards block out of the markdown; the first one that parses gives the cards. */
export function extractAnswerCards(markdown: string): ExtractedCards {
  if (!markdown.includes('```cards')) return { markdown: markdown.trim() }
  let cards: AnswerCards | undefined
  const rest = markdown.replace(FENCE_RE, (_m, body: string) => {
    if (!cards) {
      try {
        cards = buildModelCards(JSON.parse(body)) ?? undefined
      } catch {
        // Not JSON: the block is dropped either way.
      }
    }
    return ''
  })
  return { markdown: rest.replace(/\n{3,}/g, '\n\n').trim(), ...(cards ? { cards } : {}) }
}
