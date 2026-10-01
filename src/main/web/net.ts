// The one safe HTTPS GET for everything Lumen reads from the web: background fetch_url, the
// tutorial importer, page summaries and news feeds. https only, no credentials, no local or
// private hosts (by name, and again by resolved address at connect time so DNS rebinding is
// refused), every redirect hop re-checked, size and time capped, optional robots.txt. Free: no
// search API, no proxy. No Electron.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns'
import { request as httpsRequest } from 'https'
import { isIP } from 'net'
import { Readable, type Transform } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
import { assertSafeUrl, SafetyError } from '../actions/safety'
import { parseRobots, robotsAllow } from './robots'

export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 5
const ROBOTS_MAX_BYTES = 500_000

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Lumen/1.0 (reads pages on request; +robots.txt respected)'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/** Why a GET failed after the URL passed the policy (policy failures are SafetyError). */
export type WebErrorCode = 'E_ROBOTS' | 'E_TOO_LARGE' | 'E_REDIRECTS'

export class WebError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly url?: string
  ) {
    super(message)
    this.name = 'WebError'
  }
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

/** Hosts Lumen may not reach: localhost, private ranges, .local / .internal, single labels. */
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

/** The URL Lumen may fetch, or a SafetyError (https only, no credentials, no local hosts). */
export function assertFetchable(raw: string): URL {
  const url = new URL(assertSafeUrl(raw))
  if (url.protocol !== 'https:') throw new SafetyError('only https URLs can be fetched')
  if (isPrivateHost(url.hostname)) throw new SafetyError(`blocked local address: ${url.hostname}`)
  return url
}

async function readCapped(
  res: Response,
  max: number,
  overflow: 'cut' | 'throw',
  url: string
): Promise<{ bytes: Buffer; cut: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { bytes: Buffer.alloc(0), cut: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > max) {
      await reader.cancel().catch(() => {})
      if (overflow === 'throw') throw new WebError('E_TOO_LARGE', 'the page is too large', url)
      chunks.push(value.subarray(0, max - size))
      cut = true
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  return { bytes: Buffer.concat(chunks), cut }
}

/** Remembered robots.txt per origin: its rules, or 'none' when it could not be read. */
export type RobotsCache = Map<string, { rules: Rules | 'none'; at: number }>
type Rules = ReturnType<typeof parseRobots>

const ROBOTS_TTL_MS = 30 * 60_000

/** The rules of `origin`'s robots.txt; 4xx = no rules; unreachable (5xx, network) = 'none'. */
async function robotsRules(
  origin: string,
  impl: FetchImpl,
  signal: AbortSignal
): Promise<Rules | 'none'> {
  try {
    let at = new URL('/robots.txt', origin)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await impl(at.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*;q=0.5' }
      })
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (loc) {
        at = assertFetchable(new URL(loc, at).href)
        continue
      }
      if (res.status >= 400 && res.status < 500) return []
      if (!res.ok) return 'none'
      return parseRobots(
        (await readCapped(res, ROBOTS_MAX_BYTES, 'cut', at.href)).bytes.toString('utf8')
      )
    }
    return 'none'
  } catch (e) {
    if (signal.aborted) throw e
    return 'none'
  }
}

/** May Lumen fetch `u`? (RFC 9309; an unreachable robots.txt means no.) */
async function robotsOk(
  u: URL,
  impl: FetchImpl,
  signal: AbortSignal,
  cache: RobotsCache,
  now: number
): Promise<boolean> {
  let hit = cache.get(u.origin)
  if (!hit || now - hit.at >= ROBOTS_TTL_MS) {
    hit = { rules: await robotsRules(u.origin, impl, signal), at: now }
    cache.set(u.origin, hit)
  }
  return hit.rules !== 'none' && robotsAllow(hit.rules, `${u.pathname}${u.search}`)
}

export interface SafeGetOptions {
  signal?: AbortSignal
  /** Default: `pinnedFetch()` (connect-time address check). */
  fetch?: FetchImpl
  /** Check robots.txt for Lumen before every hop. */
  robots?: boolean
  /** Shared robots verdicts (default: one map per call). */
  robotsCache?: RobotsCache
  maxBytes?: number
  /** cut: keep the first maxBytes; throw: WebError E_TOO_LARGE. */
  overflow?: 'cut' | 'throw'
  accept?: string
  timeoutMs?: number
  now?: () => number
  /** Read any content type and return the raw bytes too (images). */
  binary?: boolean
}

export interface SafeGetResult {
  /** The final URL after redirects. */
  url: string
  status: number
  /** Lowercase MIME type without parameters ('' when the server sent none). */
  contentType: string
  /** The body as UTF-8; '' for a non-text type (not read). */
  body: string
  cut: boolean
  /** The raw body, only with `binary`. */
  bytes?: Buffer
}

const TEXTUAL = /^(text\/|application\/(json|xml|rss\+xml|atom\+xml|xhtml\+xml|feed\+json))/

/**
 * GET with the policy on the URL and every redirect hop (SafetyError), robots.txt when asked
 * (WebError E_ROBOTS), at most 5 redirects (E_REDIRECTS) and a size cap. Non-text bodies are
 * not read. Any status is returned; callers decide what a 404 means.
 */
export async function safeGet(raw: string, opts: SafeGetOptions = {}): Promise<SafeGetResult> {
  const impl = opts.fetch ?? pinnedFetch()
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const cache: RobotsCache = opts.robotsCache ?? new Map()
  const now = opts.now ?? Date.now
  let url = assertFetchable(raw)
  for (let hop = 0; ; hop++) {
    if (opts.robots && !(await robotsOk(url, impl, signal, cache, now())))
      throw new WebError(
        'E_ROBOTS',
        `${url.hostname} does not allow automatic reading of that page (robots.txt)`,
        url.href
      )
    const res = await impl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept ?? 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'
      }
    })
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (loc) {
      if (hop >= MAX_REDIRECTS) throw new WebError('E_REDIRECTS', 'too many redirects', url.href)
      url = assertFetchable(new URL(loc, url).toString())
      continue
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType && !TEXTUAL.test(contentType) && !opts.binary) {
      await res.body?.cancel().catch(() => {})
      return { url: url.toString(), status: res.status, contentType, body: '', cut: false }
    }
    const { bytes, cut } = await readCapped(
      res,
      opts.maxBytes ?? FETCH_MAX_BYTES,
      opts.overflow ?? 'cut',
      url.href
    )
    const base = { url: url.toString(), status: res.status, contentType, cut }
    return opts.binary ? { ...base, body: '', bytes } : { ...base, body: bytes.toString('utf8') }
  }
}
