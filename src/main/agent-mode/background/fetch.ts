// fetch_url for background tasks: plain HTTPS GET through the safety policy (assertSafeUrl),
// https only, no local or private hosts (also after every redirect), size and time capped,
// HTML reduced to text. Free: no search API, no proxy. The host name is checked first and the
// resolved addresses again at connect time (`safeLookup`), so a public name that resolves to a
// private address (DNS rebinding) is refused too.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns'
import { request as httpsRequest } from 'https'
import { isIP } from 'net'
import { Readable, type Transform } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
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
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
  // Multicast, reserved and broadcast.
  /^(22[4-9]|2[3-5]\d)\./
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
      h === '::1' || h === '::' || /^f[cdf]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h)
    )
  return false
}

export type Resolver = (
  hostname: string,
  options: { all: true; family?: number },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

const systemResolver: Resolver = (host, opts, cb) => dnsLookup(host, opts, cb)

/**
 * A `lookup` for net/tls connections that refuses a host when any address it resolves to is
 * local, private or link-local (checked at connect time, so a rebinding DNS answer between the
 * name check and the connection does not get through).
 */
export function makeSafeLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: LookupOptions | number | undefined, cb: LookupCb): void => {
    const opts = typeof options === 'object' && options ? options : {}
    const family = typeof options === 'number' ? options : opts.family
    const fam = family === 4 || family === 6 ? family : undefined
    resolve(hostname, { all: true, ...(fam ? { family: fam } : {}) }, (err, addrs) => {
      if (err) return cb(err, [])
      if (!addrs?.length)
        return cb(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), [])
      const bad = addrs.find((a) => isPrivateHost(a.address))
      if (bad)
        return cb(
          new SafetyError(
            `blocked local address: ${hostname} resolves to ${bad.address}`
          ) as unknown as NodeJS.ErrnoException,
          []
        )
      if (opts.all) return cb(null, addrs)
      cb(null, addrs[0].address, addrs[0].family)
    })
  }
}

export const safeLookup = makeSafeLookup()

function decoder(encoding: string | undefined): Transform | null {
  const e = (encoding ?? '').trim().toLowerCase()
  if (e === 'gzip' || e === 'x-gzip') return createGunzip()
  if (e === 'br') return createBrotliDecompress()
  if (e === 'deflate') return createInflate()
  return null
}

/** GET over node https with `safeLookup` on the connection (one hop, no redirects followed). */
export function pinnedFetch(lookup = safeLookup): FetchImpl {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br' }
      new Headers(init.headers).forEach((v, k) => (headers[k] = v))
      const req = httpsRequest(
        url,
        {
          method: 'GET',
          headers,
          lookup: lookup as never,
          ...(init.signal ? { signal: init.signal } : {})
        },
        (res) => {
          const out = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => out.append(k, x))
            else if (v !== undefined) out.set(k, String(v))
          }
          const status = res.statusCode ?? 502
          if ([204, 205, 304].includes(status) || status < 200) {
            res.resume()
            return resolve(
              new Response(null, { status: status < 200 ? 502 : status, headers: out })
            )
          }
          const dec = decoder(res.headers['content-encoding'])
          if (dec) out.delete('content-encoding')
          const stream = dec ? res.pipe(dec) : res
          if (dec) res.on('error', (e) => dec.destroy(e))
          resolve(
            new Response(Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>, {
              status,
              headers: out
            })
          )
        }
      )
      req.on('error', reject)
      req.end()
    })
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
  impl: FetchImpl = pinnedFetch()
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
