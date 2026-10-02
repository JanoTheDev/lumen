// Card follow-ups in the pipeline (05 T40): "the second one", "open it", "save the cheapest",
// "compare them", "the one near the beach, does it have parking?", "cheaper ones", "more like
// this". Local grammar only, while cards from the last 15 minutes are in this conversation and
// newer than a web reading context. Answers come from the card and its source page; "cheaper
// ones" / "more like this" / a question the page can't answer run a short research task.
import type { Card } from '@shared/cards'
import type { ModelResponse } from '@shared/types'
import { rememberAnswer } from './answer-link'
import {
  describeCard,
  foreignCardPhrase,
  mainCurrency,
  parseCardIntent,
  priceWords,
  resolvePick,
  type Pick,
  type PickResult
} from './followups'
import type { StoredCards } from './store'

export const FOLLOWUP_TTL_MS = 15 * 60_000

export interface CardAnswer {
  /** Spoken answer (plain sentences). */
  answer: string
  /** The card or page says it; false = not there (a research task looks it up). */
  found: boolean
}

export interface CardsTurnDeps {
  current(): StoredCards | null
  now(): number
  /** When the newest web reading context was set (0 = none); a newer one gets the follow-up. */
  webAt(): number
  openUrl(url: string): Promise<boolean>
  saveNote(note: { text: string; title?: string; url?: string }): Promise<boolean>
  openPanel(route: string): void
  /** The voice language ("nl", "de", "fr", "es" get their basic picks too). */
  lang?(): string
  /** A question about one card, from its data and its source page; null = no model. */
  ask?(
    card: Card,
    pageUrl: string | undefined,
    question: string,
    signal: AbortSignal
  ): Promise<CardAnswer | null>
  /** "book the second one" (T41): runs the booking task; the reply text is shown by the caller. */
  book?(
    card: Card,
    set: StoredCards,
    utterance: string,
    signal: AbortSignal
  ): Promise<{ text: string }>
}

/**
 * `research`: the task's goal, which quotes card text (written by a model from web pages);
 * `userText`: only the user's own words, for the policy; `observedText`: the card text it quotes.
 */
export type CardsTurn =
  | { response: ModelResponse }
  | { research: string; userText: string; observedText: string }

/** The card "it" / "that one" means: the last one picked, per card set. */
let focus: { setId: string; cardId: string } | null = null

export function resetCardFocus(): void {
  focus = null
}

function reply(set: StoredCards, text: string, keepCards = true): CardsTurn {
  if (keepCards) rememberAnswer(text, set.id)
  return { response: { mode: 'answer', text, spoken: text } }
}

const linkOf = (set: StoredCards, card: Card): string | undefined =>
  card.links[0]?.url ??
  set.cards.sources.find((s) => s.id === (card.price?.sourceId ?? card.rating?.sourceId))?.url

function noPick(set: StoredCards, r: Extract<PickResult, { ok: false }>): CardsTurn {
  const n = set.cards.cards.length
  switch (r.reason) {
    case 'no-price':
      return reply(set, 'None of these results shows a price.')
    case 'no-rating':
      return reply(set, 'None of these results shows a rating.')
    case 'ambiguous': {
      const names = (r.options ?? []).slice(0, 3).map((c) => c.title)
      return reply(
        set,
        names.length > 1
          ? `Which one: ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`
          : 'Which one? Say the first, the second, and so on.'
      )
    }
    default:
      return reply(
        set,
        `I don't see that one. There ${n === 1 ? 'is 1 result' : `are ${n} results`}.`
      )
  }
}

/** Names / ordinals that miss fall through to the normal pipeline ("the blue car" may be a request). */
const fallsThrough = (pick: Pick, r: PickResult): boolean =>
  !r.ok && r.reason === 'none' && pick.by === 'words'

function cheapest(set: StoredCards): Card | null {
  const cur = mainCurrency(set.cards.cards)
  const priced = set.cards.cards.filter((c) => c.price?.currency === cur)
  if (!priced.length) return null
  return priced.reduce((a, b) => (b.price!.amount < a.price!.amount ? b : a))
}

const cardText = (card: Card): string =>
  [card.title, card.subtitle, ...card.facts.slice(0, 3).map((f) => `${f.label} ${f.value}`)]
    .filter(Boolean)
    .join(', ')

/** The user's words a re-run goes by: their request for the set, then this follow-up. */
const ownWords = (set: StoredCards, prompt: string): string =>
  [set.request?.trim(), prompt.trim()].filter(Boolean).join('. ')

function refine(
  set: StoredCards,
  prompt: string,
  how: 'cheaper' | 'better' | 'like',
  card?: Card
): Extract<CardsTurn, { research: string }> {
  // `set.request` is the user's own words; without it the set's spoken text (model-written).
  const base = (set.request ?? set.text).trim()
  const observed: string[] = set.request ? [] : [set.text]
  const done = (research: string): Extract<CardsTurn, { research: string }> => ({
    research,
    userText: ownWords(set, prompt),
    observedText: observed.filter(Boolean).join('\n')
  })
  if (how === 'cheaper') {
    const low = cheapest(set)
    if (low) observed.push(low.title)
    return done(
      low
        ? `${base}. Only options cheaper than ${priceWords(low)} (the cheapest found so far was ${low.title}).`
        : `${base}. Only cheaper options than before.`
    )
  }
  if (how === 'better') {
    const rated = set.cards.cards.filter((c) => c.rating)
    const top = rated.length
      ? Math.max(...rated.map((c) => c.rating!.value / c.rating!.max)) * 10
      : null
    return done(
      top !== null
        ? `${base}. Only options rated higher than ${top.toFixed(1)} out of 10.`
        : `${base}. Only better rated options.`
    )
  }
  const about = card ? cardText(card) : ''
  const others = set.cards.cards.map((c) => c.title).join('; ')
  observed.push(about, others)
  return done(`${base}. More options like ${about || 'these'}, other than: ${others}.`)
}

/**
 * A card follow-up turn, or null when the utterance is not one (or no recent cards): the
 * pipeline then goes on as usual.
 */
export async function handleCardsTurn(
  prompt: string,
  signal: AbortSignal,
  deps: CardsTurnDeps
): Promise<CardsTurn | null> {
  const set = deps.current()
  if (!set || deps.now() - set.createdAt > FOLLOWUP_TTL_MS) return null
  if (deps.webAt() > set.createdAt) return null
  const foreign = deps.lang ? foreignCardPhrase(prompt, deps.lang()) : null
  // A phrase in the voice language wins ("open de goedkoopste" is not a card named so).
  const intent = (foreign ? parseCardIntent(foreign) : null) ?? parseCardIntent(prompt)
  if (!intent) return null
  const cards = set.cards.cards
  const focused = focus?.setId === set.id ? focus.cardId : null
  const pickCard = (p: Pick): PickResult => {
    const r = resolvePick(p, cards, focused)
    if (r.ok) focus = { setId: set.id, cardId: r.card.id }
    return r
  }

  switch (intent.kind) {
    case 'compare':
      deps.openPanel(`answer/${set.id}/table`)
      return reply(set, 'Here they are side by side.')
    case 'show-all':
      deps.openPanel(`answer/${set.id}`)
      return reply(set, `Here are all ${cards.length} results.`)
    case 'refine': {
      let card: Card | undefined
      if (intent.pick) {
        const r = pickCard(intent.pick)
        if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
        card = r.card
      }
      return refine(set, prompt, intent.how, card)
    }
    case 'save': {
      const chosen: Card[] = []
      if (intent.pick === 'all') chosen.push(...cards)
      else {
        const r = pickCard(intent.pick)
        if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
        chosen.push(r.card)
      }
      let saved = 0
      for (const c of chosen) {
        const lines = [
          c.title,
          c.subtitle,
          priceWords(c) && `Price: ${priceWords(c)}${c.price?.note ? ` (${c.price.note})` : ''}`,
          ...c.facts.map((f) => `${f.label}: ${f.value}`)
        ]
        const ok = await deps
          .saveNote({ text: lines.filter(Boolean).join('\n'), title: c.title, url: linkOf(set, c) })
          .catch(() => false)
        if (ok) saved++
      }
      if (!saved) return reply(set, 'Notes are not available.')
      return reply(
        set,
        chosen.length === 1
          ? `Saved ${chosen[0].title} to your notes.`
          : `Saved ${saved} results to your notes.`
      )
    }
    case 'open': {
      const r = pickCard(intent.pick)
      if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
      const url = linkOf(set, r.card)
      if (!url) return reply(set, `${r.card.title} has no link.`)
      const ok = await deps.openUrl(url).catch(() => false)
      return reply(set, ok ? `Opening ${r.card.title}.` : 'I could not open that link.')
    }
    case 'book': {
      const r = pickCard(intent.pick)
      if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
      if (!deps.book) return reply(set, 'Booking is not ready yet.')
      // Only a card with a booking button: its link is on a site the research read.
      if (!r.card.actions.some((a) => a.kind === 'do'))
        return reply(set, `I can't book ${r.card.title} from here. Say "open it" to see its page.`)
      const res = await deps.book(r.card, set, prompt, signal)
      return reply(set, res.text, false)
    }
    case 'select': {
      const r = pickCard(intent.pick)
      if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
      return reply(set, describeCard(r.card, r.index))
    }
    case 'more': {
      // "is it …" is about a card only right after one was picked.
      if (intent.onlyFocused && !focused) return null
      const r = pickCard(intent.pick)
      if (!r.ok) return fallsThrough(intent.pick, r) ? null : noPick(set, r)
      const card = r.card
      const question = intent.question ?? 'Tell me more about it.'
      const page = linkOf(set, card)
      const a = deps.ask
        ? await deps.ask(card, page, question, signal).catch((e: Error) => {
            if (signal.aborted) throw e
            return null
          })
        : null
      if (a?.found) return reply(set, a.answer)
      if (a && !a.found)
        return {
          research: `About ${card.title}${page ? ` (${page})` : ''}: ${question} Answer in one or two sentences with the source.`,
          userText: prompt,
          observedText: [cardText(card), page].filter(Boolean).join('\n')
        }
      // No model: what the card itself says.
      return reply(set, describeCard(card, r.index))
    }
  }
}
