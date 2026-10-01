// fetch_url for background tasks: plain HTTPS GET through the safety policy (assertSafeUrl),
// https only, no local or private hosts (also after every redirect), size and time capped,
// HTML reduced to text. Free: no search API, no proxy.
import { isIP } from 'net'
import { assertSafeUrl, SafetyError } from '../../actions/safety'

export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_MAX_BYTES = 1_000_000
export const FETCH_MAX_CHARS = 40_000
const MAX_REDIRECTS = 5

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
]

/** Hosts a background task may not reach: localhost, private ranges, .local / .internal. */
export function isPrivateHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true
  if (/\.(local|internal|lan|home|corp|intranet)$/.test(h) || !h.includes('.')) {
    if (!isIP(h)) return true
  }
  const v = isIP(h)
  if (v === 4) return PRIVATE_V4.some((re) => re.test(h))
  if (v === 6)
    return (
      h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h)
    )
  return false
}

/** The URL a background task may fetch, or a SafetyError. */
export function assertFetchable(raw: string): URL {
  const url = new URL(assertSafeUrl(raw))
  if (url.protocol !== 'https:') throw new SafetyError('only https URLs can be fetched')
  if (isPrivateHost(url.hostname)) throw new SafetyError(`blocked local address: ${url.hostname}`)
  return url
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** Readable text of an HTML page: no scripts, styles or tags; block ends become newlines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1))
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readCapped(res: Response, max: number): Promise<{ body: string; cut: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { body: '', cut: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size))
      cut = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  return { body: Buffer.concat(chunks).toString('utf8'), cut }
}

/** GET with every redirect hop checked again. */
export async function fetchPage(
  raw: string,
  signal: AbortSignal,
  impl: FetchImpl = (u, i) => fetch(u, i)
): Promise<FetchedPage> {
  let url = assertFetchable(raw)
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const both = AbortSignal.any([signal, timeout])
  for (let hop = 0; ; hop++) {
    const res = await impl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: both,
      headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects')
      url = assertFetchable(new URL(res.headers.get('location')!, url).toString())
      continue
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (
      contentType &&
      !/^(text\/|application\/(json|xml|rss\+xml|atom\+xml|xhtml\+xml))/.test(contentType)
    )
      return { url: url.toString(), status: res.status, contentType, text: '', truncated: false }
    const { body, cut } = await readCapped(res, FETCH_MAX_BYTES)
    let text = /html|xml/.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body.trim()
    let truncated = cut
    if (text.length > FETCH_MAX_CHARS) {
      text = text.slice(0, FETCH_MAX_CHARS)
      truncated = true
    }
    return { url: url.toString(), status: res.status, contentType, text, truncated }
  }
}
