// Research → cards (05 T39): the strict `present_cards` tool that ends a research task with a
// short spoken text plus typed cards, and the checks in front of `presentCards`. Every price and
// rating must name a source page this task actually read (fetched, opened in the browser, or
// returned by a lookup / helper task) and its number must appear in what the task read;
// otherwise the field is dropped, never guessed. Pure (no Electron).
import { z } from 'zod'
import {
  CARD_KINDS,
  CARD_LAYOUTS,
  CARD_LIMITS as L,
  type AnswerCards,
  type Card,
  type CardAction,
  type CardSource
} from '@shared/cards'
import type { AgentMessage, ToolCall, ToolDef } from '../ai/providers/types'
import { isPrivateHost } from '../web/net'

// Strict-schema subset (agent-mode/tools.ts): no optional fields at all (Anthropic caps optional
// parameters across every strict tool of a request), no unions, no numeric bounds. "Not known"
// is an empty string or an empty array.
const factInput = z.object({ label: z.string(), value: z.string() })

export const presentCardsInput = z.object({
  text: z
    .string()
    .describe(
      'Spoken summary: one or two short sentences, no markdown, no URLs ("I found 5 hotels in Nice under 150 euros a night. The cheapest is Hotel Azur.").'
    ),
  layout: z
    .enum(CARD_LAYOUTS)
    .describe('carousel for a few options, grid for many, table when comparing numbers.'),
  sources: z
    .array(
      z.object({
        id: z.string().describe('Short id, "s1", "s2", …'),
        title: z.string().describe('Site or page name.'),
        url: z.string().describe('The https page you read, exactly as opened or fetched.')
      })
    )
    .describe('Pages you read in this task that prices and ratings come from.'),
  cards: z
    .array(
      z.object({
        kind: z
          .enum(CARD_KINDS)
          .describe(
            'lodging: hotels, rentals; place: sights, restaurants, shops; product: things to buy; trip: flights, trains, buses; recipe; entity: a person, place or thing to explain; generic: anything else.'
          ),
        title: z.string(),
        subtitle: z
          .string()
          .describe(
            'Area, brand or one short line (entity: a one-line description); "" when none.'
          ),
        link: z.string().describe('https page of this option; "" when none.'),
        price: z
          .array(
            z.object({
              amount: z.number(),
              currency: z.string().describe('ISO code: EUR, USD, GBP.'),
              unit: z.string().describe('"night", "person"; "" when none.'),
              note: z.string().describe('Dates or conditions ("3–5 May"); "" when none.'),
              sourceId: z.string()
            })
          )
          .describe('0 or 1 entry: only a price read on a source page, exactly as written there.'),
        rating: z
          .array(
            z.object({
              value: z.number(),
              max: z.number().describe('5 or 10, as on the page.'),
              count: z.number().int().describe('Number of reviews; 0 when not shown.'),
              sourceId: z.string()
            })
          )
          .describe('0 or 1 entry: only a rating read on a source page.'),
        facts: z
          .array(factInput)
          .describe(
            'Up to 6 short facts read on the pages. Labels per kind: recipe "Time", "Servings"; product "Store", "Availability"; trip "Departs", "Arrives", "Duration", "Changes" (times exactly as on the page).'
          ),
        badges: z.array(z.string()).describe('Up to 3 short tags ("Sea view", "Free parking").'),
        doLabel: z
          .string()
          .describe('Button label when the user could book or buy it ("Book it"); "" otherwise.')
      })
    )
    .describe('One card per option, up to 12, best first.'),
  filters: z
    .array(z.object({ label: z.string(), match: z.string() }))
    .describe('Up to 8 filter chips: label and the word a card must mention ("beach").')
})

export type PresentCardsInput = z.infer<typeof presentCardsInput>

export const PRESENT_CARDS_TOOL: ToolDef = {
  name: 'present_cards',
  description:
    'Ends the task with a short spoken answer plus cards the user can browse, open, save and compare. Use it instead of finish when the result is a list of options (hotels, flights, products, places, recipes). Prices and ratings need the sourceId of a page you read in this task; ones that were not read there are removed.',
  schema: presentCardsInput
}

/** Which card kind and layout fits (both research prompts). */
const CARDS_KINDS_RULE =
  'Card kind: lodging for hotels and rentals, place for sights and restaurants, product for things to buy (facts "Store", "Availability"), trip for flights, trains and buses (facts "Departs", "Arrives", "Duration", "Changes"; times only as written on a page you read, never worked out), recipe (facts "Time", "Servings"), entity for a person, place or thing the user wants explained (subtitle: one line saying what it is; Lumen adds a Wikipedia summary and picture), generic otherwise. Layout table when the user compares (products, trips), else carousel for up to 6, grid for more.'

/** Prompt lines for research tasks (agent and background system prompts). */
export const CARDS_RULE_FOREGROUND = `Options to choose from (hotels, flights, products, places, recipes, people or things to explain): end with present_cards instead of finish, one card per option. Prices, ratings and facts only as read on a page in this task, each price / rating with that page as its source; never estimate or invent them, leave them out instead. Sources in this order: the page in front of the user, pages you open in the browser like any app (a search results page, then the best results), then fetch_url. Ask with ask_user only for essentials you cannot assume (dates, place, budget, people); otherwise do a broad first pass and suggest filters. ${CARDS_KINDS_RULE}`

export const CARDS_RULE_BACKGROUND = `Options to choose from (hotels, flights, products, places, recipes, people or things to explain): end with present_cards instead of finish, one card per option. Prices, ratings and facts only as read on a fetched page, each price / rating with that page as its source; never estimate or invent them, leave them out instead. Ask only for essentials you cannot assume (dates, place, budget, people). ${CARDS_KINDS_RULE}`

// ---- what the task observed ----

export interface Observed {
  /** Normalized URLs of pages the task read (host without www + path). */
  urls: Set<string>
  /** Text of every successful tool result, for the number check. */
  text: string
}

const MAX_OBSERVED_TEXT = 600_000

/** host (no www) + path without a trailing slash; query and hash ignored. Null if not http(s). */
export function normUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '')
    return `${host}${path}`
  } catch {
    return null
  }
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+/g
const SOURCE_RE = /<observed source="web (https?:\/\/[^"]+)">/g

/** Tools that read pages on the task's behalf: every link in their result counts as read. */
const READS_LINKS = (name: string): boolean =>
  name === 'lookup_howto' || name === 'spawn_task' || name.startsWith('mcp__')

/** run_subagents (08 T49): the pages its sub-agents fetched, listed by Lumen (not the model). */
const SUBAGENT_SOURCES_RE = /<sources>([\s\S]*?)<\/sources>/g

/**
 * The URLs one successful tool result counts as read: the URL it opened or fetched, fetched
 * pages' fences, links named by tools that read pages, sub-agents' fetched pages. Raw strings.
 */
export function readUrls(name: string, input: Record<string, unknown>, text: string): string[] {
  const out: string[] = []
  if ((name === 'navigate' || name === 'fetch_url') && typeof input.url === 'string')
    out.push(input.url)
  for (const s of text.matchAll(SOURCE_RE)) out.push(s[1])
  if (READS_LINKS(name)) out.push(...(text.match(URL_RE) ?? []))
  if (name === 'run_subagents')
    for (const block of text.matchAll(SUBAGENT_SOURCES_RE))
      out.push(...(block[1].match(URL_RE) ?? []))
  return out
}

/**
 * What a task read, from its conversation: successful tool results (text), the URLs it opened
 * (navigate) or fetched (fetch_url, the fetched page's final URL), and the links named by tools
 * that read pages for it (how-to lookups, helper tasks, connectors). `extraUrls`: pages known
 * another way (the browser's address bar now).
 */
export function observedFrom(
  messages: readonly AgentMessage[],
  extraUrls: readonly (string | null | undefined)[] = []
): Observed {
  const calls = new Map<string, ToolCall>()
  const urls = new Set<string>()
  const parts: string[] = []
  let size = 0
  const addUrl = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    const n = normUrl(raw.replace(/[.,;:!?]+$/, ''))
    if (n) urls.add(n)
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.calls) calls.set(c.id, c)
      continue
    }
    for (const block of m.content) {
      if (block.type !== 'tool_result' || block.isError) continue
      const call = calls.get(block.id)
      const t = block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      if (call) readUrls(call.name, call.input, t).forEach(addUrl)
      else for (const s of t.matchAll(SOURCE_RE)) addUrl(s[1])
      if (size < MAX_OBSERVED_TEXT) {
        parts.push(t)
        size += t.length
      }
    }
  }
  for (const u of extraUrls) addUrl(u)
  return { urls, text: parts.join('\n') }
}

/** Ways a number may be written on a page: 1299, 1,299, 1.299, 1 299, 1299.00, 8.6, 8,6. */
export function numberForms(n: number): string[] {
  if (!Number.isFinite(n) || n < 0) return []
  const forms = new Set<string>()
  const intPart = Math.trunc(n)
  const frac = Math.round((n - intPart) * 100)
  const groups = (sep: string): string => String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  const ints = new Set([String(intPart), groups(','), groups('.'), groups(' '), groups(' ')])
  for (const i of ints) {
    if (frac === 0) {
      forms.add(i)
      if (!i.includes('.')) forms.add(`${i}.00`)
      if (!i.includes(',')) forms.add(`${i},00`)
    } else {
      const two = String(frac).padStart(2, '0')
      const one = two.endsWith('0') ? two[0] : null
      for (const sep of ['.', ',']) {
        if (sep === '.' && i.includes('.')) continue
        if (sep === ',' && i.includes(',')) continue
        forms.add(`${i}${sep}${two}`)
        if (one) forms.add(`${i}${sep}${one}`)
      }
    }
  }
  return [...forms]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The number appears in `text` as a whole number (not part of a longer one). */
export function numberSeen(n: number, text: string): boolean {
  return numberForms(n).some((f) =>
    new RegExp(`(?<![\\d.,])${escapeRe(f)}(?![\\d]|[.,]\\d)`).test(text)
  )
}

/** Clock times in a fact value ("08:12", "8.05 pm" → "8:05", "14h30" → "14:30"). */
export function clockTimes(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(/(?<![\d:.])([01]?\d|2[0-3])[:.h]([0-5]\d)(?![\d])/g))
    out.push(`${Number(m[1])}:${m[2]}`)
  return out
}

/** Every clock time of `value` appears in `text` (as 8:05, 08:05, 8.05 or 8h05). */
export function timesSeen(value: string, text: string): boolean {
  const have = new Set(clockTimes(text))
  return clockTimes(value).every((t) => have.has(t))
}

// ---- input → AnswerCards ----

const CURRENCY: Record<string, string> = {
  '€': 'EUR',
  EURO: 'EUR',
  EUROS: 'EUR',
  $: 'USD',
  US$: 'USD',
  '£': 'GBP',
  '¥': 'JPY',
  CHF: 'CHF'
}

const cut = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max).trim()

function httpsUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s || s.length > L.url) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' || u.username || u.password || isPrivateHost(u.hostname))
      return null
    return u.href
  } catch {
    return null
  }
}

const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '')

export interface BuiltCards {
  cards: AnswerCards
  text: string
  /** Fields removed and why ("Hotel Azur: price not on a page read in this task"). */
  dropped: string[]
}

export type BuildResult = ({ ok: true } & BuiltCards) | { ok: false; error: string }

/**
 * Turns the tool input into cards that pass `validateCards`: caps applied, bad links left out,
 * and each price / rating kept only when its source page was read in this task and its number
 * appears in what was read.
 */
export function buildAnswerCards(
  input: PresentCardsInput,
  seen: Observed,
  now: number
): BuildResult {
  const text = cut(input.text, L.text)
  if (!text) return { ok: false, error: 'text is empty: give a one or two sentence summary.' }
  const dropped: string[] = []

  const sources: CardSource[] = []
  const read = new Set<string>()
  for (const s of input.sources) {
    const url = httpsUrl(s.url)
    const id = s.id.trim()
    if (!url || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || sources.some((x) => x.id === id)) continue
    if (sources.length >= L.sources) break
    sources.push({ id, title: cut(s.title, L.title) || hostOf(url), url, checkedAt: now })
    const n = normUrl(url)
    if (n && seen.urls.has(n)) read.add(id)
  }
  const sourceOf = (id: string): CardSource | undefined => sources.find((s) => s.id === id.trim())

  const check = (title: string, what: string, sourceId: string, value: number): boolean => {
    const src = sourceOf(sourceId)
    if (!src) dropped.push(`${title}: ${what} has no known source`)
    else if (!read.has(src.id)) dropped.push(`${title}: ${what} source was not read in this task`)
    else if (!numberSeen(value, seen.text))
      dropped.push(`${title}: ${what} ${value} is not on the pages read`)
    else return true
    return false
  }

  const many = input.cards.length > 1
  const cards: Card[] = []
  for (const c of input.cards) {
    if (cards.length >= L.cards) break
    const title = cut(c.title, L.title)
    if (!title) continue
    const card: Card = {
      id: `c${cards.length + 1}`,
      kind: c.kind,
      title,
      facts: c.facts
        .map((f) => ({ label: cut(f.label, L.label), value: cut(f.value, L.value) }))
        .filter((f) => f.label && f.value)
        .filter((f) => {
          // Trip times only as read on a page in this task (never worked out).
          if (c.kind !== 'trip' || timesSeen(f.value, seen.text)) return true
          dropped.push(`${title}: ${f.label} ${f.value} is not on the pages read`)
          return false
        })
        .slice(0, L.facts),
      links: [],
      actions: []
    }
    const subtitle = cut(c.subtitle, L.subtitle)
    if (subtitle) card.subtitle = subtitle
    const link = httpsUrl(c.link)
    if (link) card.links.push({ label: cut(hostOf(link), L.label), url: link })

    const p = c.price[0]
    if (p && Number.isFinite(p.amount) && p.amount >= 0 && p.amount <= 1e9) {
      const raw = p.currency.trim().toUpperCase()
      const currency = CURRENCY[raw] ?? raw
      if (!/^[A-Z]{3}$/.test(currency)) dropped.push(`${title}: price has no currency code`)
      else if (check(title, 'price', p.sourceId, p.amount)) {
        const src = sourceOf(p.sourceId)!
        const note = cut(
          `from ${hostOf(src.url)}${p.note.trim() ? `, ${p.note.trim()}` : ''}, may change`,
          L.note
        )
        card.price = { amount: p.amount, currency, note, sourceId: src.id }
        const unit = cut(p.unit, L.label)
        if (unit) card.price.unit = unit
      }
    }
    const r = c.rating[0]
    if (r && Number.isFinite(r.value) && r.max > 0 && r.max <= 100 && r.value >= 0) {
      if (r.value > r.max) dropped.push(`${title}: rating above its maximum`)
      else if (check(title, 'rating', r.sourceId, r.value)) {
        card.rating = { value: r.value, max: r.max, sourceId: sourceOf(r.sourceId)!.id }
        if (Number.isInteger(r.count) && r.count > 0) card.rating.count = r.count
      }
    }
    const badges = c.badges
      .map((b) => cut(b, L.label))
      .filter(Boolean)
      .slice(0, L.badges)
    if (badges.length) card.badges = badges

    const actions: CardAction[] = []
    if (card.links.length) actions.push({ kind: 'open' })
    actions.push({ kind: 'save' }, { kind: 'more' })
    if (many) actions.push({ kind: 'compare' })
    const doLabel = cut(c.doLabel, L.label)
    if (doLabel && card.links.length) actions.push({ kind: 'do', label: doLabel })
    card.actions = actions
    cards.push(card)
  }
  if (!cards.length) return { ok: false, error: 'no cards: give at least one option.' }

  const filters = input.filters
    .map((f) => ({ label: cut(f.label, L.label), match: cut(f.match, L.label) }))
    .filter((f) => f.label && f.match)
    .slice(0, L.filters)
  // Sources a card still points at, or pages the task read.
  const used = new Set(cards.flatMap((c) => [c.price?.sourceId, c.rating?.sourceId]))
  const kept = sources.filter((s) => used.has(s.id) || read.has(s.id))
  return {
    ok: true,
    text,
    dropped,
    cards: {
      layout: input.layout,
      cards,
      sources: kept,
      ...(filters.length ? { filters } : {})
    }
  }
}
