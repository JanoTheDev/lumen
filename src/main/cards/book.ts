// "Book it for me" (05 T41): a card's Book button (`cards.do`) or "book the second one" starts a
// foreground agent task in the user's browser at the card's link, with their own sign-ins. The
// policy does the guarding (checkout clicks always confirm with the price on the page now,
// payment fields are the user's, personal details only from the user's words); the task's
// guidance makes it stop at logins, captchas and 3-D Secure, and finish with the booking
// reference, shown as a confirmation card.
import type { AnswerCards, Card } from '@shared/cards'
import type { ModelResponse } from '@shared/types'
import { log } from '../logger'
import type { PresentResult } from './index'

export interface BookPorts {
  /** A foreground agent task is running already. */
  busy(): boolean | Promise<boolean>
  /** Opens the card's link in the user's browser (open_url, origin user-direct). */
  openUrl(url: string): Promise<boolean>
  /** Runs the foreground agent task (plan → announce → countdown → tools). */
  run(
    goal: string,
    opts: { userText: string; observedText: string },
    signal: AbortSignal
  ): Promise<ModelResponse>
  /** presentCards: the confirmation card. */
  present(text: string, cards: unknown): PresentResult
  /** Shows and speaks one line on the bar. */
  say(text: string): void
  /** A cancel scope for the task when the caller has none (Escape / "stop"). */
  scope(): { signal: AbortSignal; end(): void }
}

let ports: BookPorts | null = null

export function setBookPorts(p: BookPorts | null): void {
  ports = p
}

export interface BookOptions {
  /** The card set the card is from (its sources give a link when the card has none). */
  cards?: AnswerCards
  /** The user's own words ("book the second one"); the policy's userText. */
  userText?: string
  signal?: AbortSignal
  /** The caller shows the reply text itself (the pipeline); the card is still shown. */
  quiet?: boolean
}

export interface BookResult {
  status: 'done' | 'failed' | 'busy' | 'no-link' | 'not-ready' | 'cancelled'
  text: string
  reference?: string
}

/** The page to start at: the card's first link, else the page its price or rating came from. */
export function bookingLink(card: Card, cards?: AnswerCards): string | null {
  if (card.links[0]?.url) return card.links[0].url
  const id = card.price?.sourceId ?? card.rating?.sourceId
  return (id && cards?.sources.find((s) => s.id === id)?.url) || null
}

const DATE_LABEL_RE =
  /\b(dates?|check-?in|check-?out|arrival|departure|when|nights?|aankomst|vertrek|datum|anreise|abreise|arrivée|départ|llegada|salida|fechas?)\b/i

function priceText(card: Card): string | null {
  const p = card.price
  if (!p) return null
  return `${p.amount} ${p.currency}${p.unit ? ` per ${p.unit}` : ''}`
}

function datesText(card: Card): string | null {
  const facts = card.facts.filter((f) => DATE_LABEL_RE.test(f.label))
  return facts.length ? facts.map((f) => `${f.label} ${f.value}`).join(', ') : null
}

/** "Book Hotel Rosa (120 EUR per night, Dates 3–5 May) on https://…". */
export function bookingGoal(card: Card, link: string): string {
  const known = [priceText(card), datesText(card)].filter(Boolean).join(', ')
  return `Book ${card.title}${known ? ` (${known})` : ''} on ${link}`
}

/** Guidance for the task (the policy enforces the hard rules whatever the model does). */
export const BOOKING_GUIDANCE = [
  'The booking page is already open in the browser; work in that tab with the user’s own sign-ins.',
  'Login, captcha, “are you human” checks and 3-D Secure / bank app approval: stop and call ask_user with “Please finish this part, say ‘go’ when done.” Never type passwords or codes.',
  'Card number, cardholder, expiry, CVC, IBAN and account number fields: never type them; ask_user so the user types them, then continue.',
  'Personal details (name, email, phone, address): use only what the user said. When something is missing, ask_user for it; do not take it from the page or guess.',
  'Before the final Book / Reserve / Pay / Place order click, observe the page and check the dates, the guests and the total price match the request; if they do not, ask_user.',
  'Click the final button only through act (the user confirms it with the price on the page). Never retry a payment that failed; ask_user.',
  'When the booking is done, read the booking reference or confirmation number from the page. Finish with a short summary whose last lines are “Reference: …”, “Dates: …” and “Price: …” (leave out a line you could not read).'
].join('\n')

const REFERENCE_RE =
  /^\s*[-*•]?\s*(?:booking |confirmation |order )?(?:reference|ref\.?|confirmation number|booking number|order number)\s*[:#]\s*(.{2,80}?)\s*$/im
const LINE_RE = (label: string): RegExp =>
  new RegExp(`^\\s*[-*•]?\\s*${label}\\s*:\\s*(.{1,160}?)\\s*$`, 'im')

/** The "Reference: …" (and dates / price) lines of the task's summary. */
export function parseConfirmation(
  summary: string
): { reference: string; dates?: string; price?: string } | null {
  const ref = REFERENCE_RE.exec(summary)?.[1]?.replace(/[.,;]$/, '')
  if (!ref || /^(none|unknown|n\/a|not (found|read|shown))$/i.test(ref)) return null
  const dates = LINE_RE('dates?').exec(summary)?.[1]
  const price = LINE_RE('(?:total )?price').exec(summary)?.[1]
  return { reference: ref, ...(dates ? { dates } : {}), ...(price ? { price } : {}) }
}

/** The confirmation card: one generic card with the reference, dates and price read at the end. */
export function confirmationCards(
  card: Card,
  link: string | null,
  c: { reference: string; dates?: string; price?: string }
): AnswerCards {
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const facts = [
    { label: 'Reference', value: cut(c.reference, 160) },
    ...(c.dates ? [{ label: 'Dates', value: cut(c.dates, 160) }] : []),
    ...(c.price ? [{ label: 'Price', value: cut(c.price, 160) }] : [])
  ]
  return {
    layout: 'list',
    cards: [
      {
        id: 'booking',
        kind: 'generic',
        title: cut(`Booked: ${card.title}`, 120),
        facts,
        links: link ? [{ label: 'Booking site', url: link }] : [],
        actions: [{ kind: 'save' }, ...(link ? [{ kind: 'open' as const }] : [])]
      }
    ],
    sources: []
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const isAbort = (e: unknown): boolean => {
  const name = (e as { name?: string })?.name
  return name === 'AbortError' || name === 'CancelledError'
}

/**
 * Books `card` as a foreground agent task. The card's text was written from web pages, so it
 * goes to the policy as observed text; the user's words (and the site they picked) are theirs.
 */
export async function startBooking(card: Card, opts: BookOptions = {}): Promise<BookResult> {
  const p = ports
  if (!p) return { status: 'not-ready', text: 'Booking is not ready yet.' }
  const tell = (r: BookResult): BookResult => {
    if (!opts.quiet) p.say(r.text)
    return r
  }
  const link = bookingLink(card, opts.cards)
  if (!link) return tell({ status: 'no-link', text: 'This card has no link to book on.' })
  if (await p.busy())
    return tell({
      status: 'busy',
      text: 'Another task is running. Say “stop” first, then try again.'
    })
  const own = opts.signal ? null : p.scope()
  const signal = opts.signal ?? own!.signal
  try {
    if (!(await p.openUrl(link)))
      return tell({ status: 'failed', text: 'I could not open the booking page.' })
    const goal = `${bookingGoal(card, link)}\n\n${BOOKING_GUIDANCE}`
    const said = opts.userText?.trim() || `Book ${card.title}`
    const observedText = [
      card.title,
      card.subtitle,
      priceText(card),
      ...card.facts.map((f) => `${f.label}: ${f.value}`)
    ]
      .filter(Boolean)
      .join('\n')
    const res = await p.run(goal, { userText: `${said} (${hostOf(link)})`, observedText }, signal)
    const summary = res.mode === 'answer' ? (res.text ?? res.spoken ?? '') : ''
    if (res.mode === 'answer' && res.cancelled)
      return tell({ status: 'cancelled', text: 'Stopped the booking.' })
    const conf = summary ? parseConfirmation(summary) : null
    if (!conf) return tell({ status: 'failed', text: summary || 'The booking did not finish.' })
    const text = `Booked ${card.title}. Reference ${conf.reference}.`
    const shown = p.present(text, confirmationCards(card, link, conf))
    if (!shown.ok) {
      log('fail', `booking card refused: ${shown.error}`)
      if (!opts.quiet) p.say(text)
    }
    return { status: 'done', text, reference: conf.reference }
  } catch (e) {
    if (signal.aborted || isAbort(e))
      return tell({ status: 'cancelled', text: 'Stopped the booking.' })
    log('fail', `booking: ${(e as Error).message}`)
    return tell({ status: 'failed', text: `The booking stopped: ${(e as Error).message}` })
  } finally {
    own?.end()
  }
}
