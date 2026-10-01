// The page the user is looking at (05 T29), cheapest and most faithful first:
// 1. the browser's own document text through UIA (no network; works for logged-in and
//    paywalled pages the user can already see),
// 2. the address-bar URL (native browser_url) → safe https GET (robots.txt respected) →
//    article extraction, cached 15 minutes,
// 3. OCR of the window: only the visible part, and the card says so.
// Ports are injected; no Electron here.
import { cachedPage, cachePage, hostOf, type PageRead } from './context'
import { readablePage } from './extract'

/** Less text than this is not the article (a toolbar, an empty tab). */
export const MIN_PAGE_CHARS = 280

export interface PagePorts {
  /** UIA document text of the foreground window ('' when none). */
  documentText(): Promise<{ text: string; name?: string } | null>
  /** The front browser's address-bar URL. */
  browserUrl(): Promise<{ url: string | null; title: string } | null>
  /** OCR text of the foreground window. */
  ocrWindow(): Promise<string>
  /** Safe GET of an https page (robots.txt checked): final URL and HTML. */
  fetchHtml(url: string, signal: AbortSignal): Promise<{ url: string; html: string }>
  log(msg: string): void
}

const BROWSER_SUFFIX =
  / [-—–] (?:Google Chrome|Microsoft.? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc|Zen Browser|LibreWolf)$/i

/** Window title without the browser's name ("Story - BBC News - Google Chrome" → "Story - BBC News"). */
export function pageTitle(windowTitle: string): string {
  return windowTitle
    .replace(BROWSER_SUFFIX, '')
    .replace(/ and \d+ more pages?$/i, '')
    .trim()
}

/** Reads an https page through the cache. */
export async function readUrl(
  url: string,
  ports: PagePorts,
  signal: AbortSignal
): Promise<PageRead> {
  const hit = cachedPage(url)
  if (hit) return hit
  const res = await ports.fetchHtml(url, signal)
  const r = readablePage(res.html, res.url)
  const page: PageRead = {
    title: r.title,
    url: r.canonical || res.url,
    site: r.site || hostOf(res.url),
    text: r.text,
    source: 'fetch'
  }
  cachePage(url, page)
  return page
}

/** The page in front, or null when nothing readable was found. */
export async function acquirePage(ports: PagePorts, signal: AbortSignal): Promise<PageRead | null> {
  const [doc, bar] = await Promise.all([
    ports.documentText().catch(() => null),
    ports.browserUrl().catch(() => null)
  ])
  signal.throwIfAborted()
  const url = bar?.url && /^https:\/\//i.test(bar.url) ? bar.url : ''
  const title = pageTitle(bar?.title ?? '') || doc?.name || ''
  if (doc && doc.text.trim().length >= MIN_PAGE_CHARS) {
    ports.log(`web: page from the screen (${doc.text.length} chars)`)
    return { title, url, site: url ? hostOf(url) : '', text: doc.text, source: 'screen' }
  }
  if (url) {
    try {
      const page = await readUrl(url, ports, signal)
      if (page.text.length >= MIN_PAGE_CHARS) {
        ports.log(`web: page fetched (${page.text.length} chars)`)
        return { ...page, title: page.title || title }
      }
    } catch (e) {
      signal.throwIfAborted()
      ports.log(`web: fetch failed (${(e as Error).message})`)
    }
  }
  const ocr = (await ports.ocrWindow().catch(() => '')).trim()
  signal.throwIfAborted()
  if (ocr.length >= 80) {
    ports.log(`web: page from OCR (${ocr.length} chars)`)
    return { title, url, site: url ? hostOf(url) : '', text: ocr, source: 'ocr' }
  }
  return null
}
