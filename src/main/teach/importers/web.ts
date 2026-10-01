// Web tutorial pages → readable text (11 T12). A plain https GET of the article the user
// named, only when the site's robots.txt allows it for Lumen; redirects are followed by hand
// (https only, robots checked again on a new host); local and private addresses are refused;
// at most 2 MB is read. Scripts, styles, menus and footers are dropped; image alt text is
// kept as "[image: …]". No Electron (fetch is injected).
import { parseRobots, robotsAllow } from './robots'

export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_ARTICLE_CHARS = 60_000
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Lumen/1.0 (tutorial importer; +robots.txt respected)'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class ImportError extends Error {}

/** localhost, private, link-local and loopback addresses (literal hosts only). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (/(^|\.)(localhost|local|internal|home|lan)$/.test(h)) return true
  // IPv6 literal: loopback, unspecified, link-local, unique-local, v4-mapped.
  if (h.includes(':')) return /^(::1?|fe[89ab]|f[cd]|::ffff:)/.test(h)
  // Single-label names are intranet hosts.
  if (!h.includes('.')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function checkUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ImportError('that is not a web address')
  }
  if (u.protocol !== 'https:') throw new ImportError('only https pages can be imported')
  if (u.username || u.password) throw new ImportError('addresses with a password are not imported')
  if (isPrivateHost(u.hostname))
    throw new ImportError('local and private addresses are not imported')
  return u
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new ImportError('the page is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** May Lumen fetch `u`? 4xx robots = yes; unreachable robots (5xx, network) = no (RFC 9309). */
async function robotsOk(
  u: URL,
  fetch: FetchLike,
  signal: AbortSignal,
  cache: Map<string, boolean>
): Promise<boolean> {
  const path = `${u.pathname}${u.search}`
  const key = `${u.origin} ${path}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let ok: boolean
  try {
    const res = await fetch(`${u.origin}/robots.txt`, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal
    })
    if (res.status >= 400 && res.status < 500) ok = true
    else if (!res.ok) ok = false
    else ok = robotsAllow(parseRobots(await readCapped(res, 500_000)), path)
  } catch (e) {
    if (e instanceof ImportError) throw e
    ok = false
  }
  cache.set(key, ok)
  return ok
}

/** The page's HTML after robots and redirect checks. Throws ImportError with a reason. */
export async function fetchPage(
  raw: string,
  fetch: FetchLike,
  signal?: AbortSignal
): Promise<{ url: string; html: string }> {
  const sig = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS)
  const robots = new Map<string, boolean>()
  let u = checkUrl(raw)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await robotsOk(u, fetch, sig, robots)))
      throw new ImportError(
        `${u.hostname} does not allow automatic reading of that page (robots.txt)`
      )
    const res = await fetch(u.href, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: sig
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new ImportError('the page redirects nowhere')
      u = checkUrl(new URL(loc, u).href)
      continue
    }
    if (!res.ok) throw new ImportError(`the page answered ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (type && !/html|xml|text\/plain/i.test(type))
      throw new ImportError('that address is not a web page')
    return { url: u.href, html: await readCapped(res, MAX_PAGE_BYTES) }
  }
  throw new ImportError('too many redirects')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const DROP = [
  'script',
  'style',
  'noscript',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'template',
  'button'
]

/** The page title and its main text (article / main / body), markdown-ish. */
export function htmlToArticle(html: string): { title: string; text: string } {
  let h = html.replace(/<!--[\s\S]*?-->/g, '')
  const title = decodeEntities(
    (
      /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(h)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h)?.[1] ??
      ''
    ).replace(/<[^>]+>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
  for (const tag of DROP) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  const pick = (tag: string): string | null => {
    const all = [...h.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(
      (m) => m[1]
    )
    return all.length ? all.sort((a, b) => b.length - a.length)[0] : null
  }
  const body = pick('article') ?? pick('main') ?? pick('body') ?? h
  const text = decodeEntities(
    body
      .replace(/<img\b[^>]*\balt=["']([^"']{3,})["'][^>]*>/gi, '\n[image: $1]\n')
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t}\n`
      )
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(?:kbd|code)\b[^>]*>([\s\S]*?)<\/(?:kbd|code)>/gi, '`$1`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|tr|pre|blockquote|ul|ol|table|figure)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ARTICLE_CHARS)
  return { title, text }
}
