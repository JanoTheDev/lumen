// The price on the page right now, for the confirm card of a book / pay / order click (05 T41):
// what the user approves is what the page says at that moment, never the card's old price.
// The window's document text through UI Automation first, OCR of the window when that is thin
// (as observe "text" does); the price is picked locally, nothing is sent anywhere.
import { getAgent } from '../agent/instance'
import type { ActiveWindowInfo, OcrResult } from '../agent/commands'
import { log } from '../logger'
import type { Decision } from './safety'

export const PRICE_NOT_READ = 'price not read, check the page'

const TEXT_TIMEOUT_MS = 2000
const OCR_TIMEOUT_MS = 4000
const MAX_TEXT = 60_000
/** Document text shorter than this is a toolbar or an empty pane: OCR the window instead. */
const MIN_DOC_CHARS = 80

const SYMBOL = '(?:€|\\$|£|¥|₹|CHF|kr|zł)'
const CODE = '(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|INR)'
const AMOUNT = '(?:\\d{1,3}(?:[.,\\s\\u00a0\\u202f]\\d{3})+|\\d+)(?:[.,]\\d{1,2})?(?!\\d)'
const PRICE_RE = new RegExp(
  `(?:(?:${SYMBOL}|${CODE})[ \\u00a0]?(?:${AMOUNT}))|(?:(?:${AMOUNT})[ \\u00a0]?(?:${SYMBOL}|${CODE}))(?![\\p{L}])`,
  'gu'
)
/** Lines that hold the amount to pay (en/nl/de/fr/es). */
const TOTAL_RE =
  /\b(total|grand total|amount due|to pay|you pay|totaal|te betalen|totaalprijs|gesamt|gesamtbetrag|gesamtpreis|summe|zu zahlen|montant total|total à payer|à payer|importe total|total a pagar|precio total)\b/i

interface PriceHit {
  text: string
  index: number
  total: boolean
}

function hits(text: string): PriceHit[] {
  const out: PriceHit[] = []
  for (const m of text.matchAll(PRICE_RE)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const lineEnd = text.indexOf('\n', m.index)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    // A total's label may sit on the line above its amount (OCR, table cells).
    const prevStart = text.lastIndexOf('\n', Math.max(0, lineStart - 2)) + 1
    const prev = lineStart > 0 ? text.slice(prevStart, lineStart) : ''
    out.push({
      text: m[0].replace(/\s+/g, ' ').trim(),
      index: m.index,
      total: TOTAL_RE.test(line) || (!hasPrice(prev) && TOTAL_RE.test(prev))
    })
  }
  return out
}

function hasPrice(s: string): boolean {
  return new RegExp(PRICE_RE.source, 'u').test(s)
}

/**
 * The price the user is about to pay in `text`: the last amount on a "Total" / "Te betalen"
 * line, else the amount nearest the button's word, else the last amount on the page.
 */
export function findPrice(text: string, near?: string): string | null {
  const all = hits(text)
  if (!all.length) return null
  const totals = all.filter((h) => h.total)
  if (totals.length) return totals[totals.length - 1].text
  if (near) {
    const at = text.toLowerCase().lastIndexOf(near.toLowerCase())
    if (at >= 0)
      return all.reduce((a, b) => (Math.abs(b.index - at) < Math.abs(a.index - at) ? b : a)).text
  }
  return all[all.length - 1].text
}

/** The readable text of the window in front, or '' (no agent, timeouts). */
async function windowText(): Promise<string> {
  const agent = getAgent()
  if (!agent) return ''
  const doc = agent.hasCapability('uia-text')
    ? await agent
        .request<{ text: string }>(
          'uia_text',
          { scope: 'document', maxChars: MAX_TEXT },
          { timeoutMs: TEXT_TIMEOUT_MS }
        )
        .then((r) => r?.text?.trim() ?? '')
        .catch(() => '')
    : ''
  if (doc.length >= MIN_DOC_CHARS) return doc
  const w = await agent.request<ActiveWindowInfo>(
    'active_window',
    {},
    { timeoutMs: TEXT_TIMEOUT_MS }
  )
  if (w.rect.w <= 0 || w.rect.h <= 0) return doc
  const r = await agent.request<OcrResult>('ocr', { region: w.rect }, { timeoutMs: OCR_TIMEOUT_MS })
  return r.lines.map((l) => l.text).join('\n') || doc
}

/** Adds "price on the page now: €123" (or that it could not be read) to a checkout decision. */
export async function withCheckoutPrice(
  d: Decision,
  read: () => Promise<string> = windowText
): Promise<Decision> {
  if (!d.checkout) return d
  const text = await read().catch((e: Error) => {
    log('fail', `checkout price: ${e.message}`)
    return ''
  })
  const price = text ? findPrice(text, d.checkout) : null
  return {
    ...d,
    reason: `${d.reason}; ${price ? `price on the page now: ${price}` : PRICE_NOT_READ}`
  }
}
