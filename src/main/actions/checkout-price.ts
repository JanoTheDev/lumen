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
/** Lines that hold the amount to pay (en/nl/de/fr/es/it/pt). */
const TOTAL_RE =
  /\b(total|grand total|amount due|to pay|you pay|totaal|te betalen|totaalprijs|gesamt|gesamtbetrag|gesamtpreis|summe|zu zahlen|montant total|total à payer|à payer|importe total|total a pagar|precio total|totale|importo|valor total)\b/i
/** Labels that name what is charged, preferred over a plain "Total". */
const PAY_TOTAL_RE =
  /\b(grand total|order total|total due|total to pay|amount due|amount to pay|to pay|you pay|te betalen|zu zahlen|gesamtbetrag|total à payer|à payer|total a pagar|totale da pagare|totale ordine|valor total)\b/i
/** Lines that are not the charge: savings, discounts, subtotals. */
const NOT_CHARGE_RE =
  /\b(sav(?:e|ed|ings?)|you save|discount|korting|rabatt|ersparnis|remise|économie|descuento|ahorro|sconto|desconto|sub-?\s?total|subtotaal|zwischensumme|sous-total|subtotale)\b/i

interface PriceHit {
  text: string
  index: number
  value: number
  total: boolean
  /** "Order total", "Amount due", "Te betalen". */
  payTotal: boolean
  /** A savings, discount or subtotal line, or a negative amount. */
  notCharge: boolean
}

/** "1.234,56 €" → 1234.56, "$1,299.99" → 1299.99. */
function amountOf(s: string): number {
  const digits = s.replace(/[^\d.,]/g, '')
  const m = /[.,](\d{1,2})$/.exec(digits)
  const whole = (m ? digits.slice(0, m.index) : digits).replace(/\D/g, '')
  return Number(`${whole || '0'}.${m ? m[1] : '0'}`)
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
    const label = TOTAL_RE.test(line) || hasPrice(prev) ? line : `${prev} ${line}`
    out.push({
      text: m[0].replace(/\s+/g, ' ').trim(),
      index: m.index,
      value: amountOf(m[0]),
      total: TOTAL_RE.test(label),
      payTotal: PAY_TOTAL_RE.test(label),
      notCharge: NOT_CHARGE_RE.test(label) || /[-−–]\s*$/.test(text.slice(lineStart, m.index))
    })
  }
  return out
}

function hasPrice(s: string): boolean {
  return new RegExp(PRICE_RE.source, 'u').test(s)
}

/** Several different totals: the one nearest the button, else the largest. */
function pickTotal(totals: PriceHit[], text: string, near?: string): PriceHit {
  if (new Set(totals.map((h) => h.value)).size === 1) return totals[totals.length - 1]
  const at = near ? text.toLowerCase().lastIndexOf(near.toLowerCase()) : -1
  if (at >= 0)
    return totals.reduce((a, b) => (Math.abs(b.index - at) < Math.abs(a.index - at) ? b : a))
  return totals.reduce((a, b) => (b.value > a.value ? b : a))
}

/**
 * The price the user is about to pay in `text`: an "Order total" / "Amount due" / "Te betalen"
 * amount, else a "Total" one (savings, discounts, subtotals and €0 "paid now" lines left out;
 * several different totals: the one nearest the button, else the largest), else the amount
 * nearest the button's word, else the last amount on the page. null when the page has
 * discounts or subtotals but no total: the charge cannot be told for sure.
 */
export function findPrice(text: string, near?: string): string | null {
  const found = hits(text)
  const all = found.filter((h) => !h.notCharge)
  const charged = all.filter((h) => h.total && h.value > 0)
  const totals = charged.some((h) => h.payTotal) ? charged.filter((h) => h.payTotal) : charged
  if (totals.length) return pickTotal(totals, text, near).text
  if (!all.length || found.some((h) => h.notCharge)) return null
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
