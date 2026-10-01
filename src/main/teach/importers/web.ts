// Web tutorial pages → readable text (11 T12). The shared safe GET (web/net) of the article the
// user named, only when the site's robots.txt allows it for Lumen; https only on every hop,
// local and private addresses refused, at most 2 MB read. The article extractor lives in
// web/extract. No Electron (fetch is injected).
import { SafetyError } from '../../actions/safety'
import { safeGet, WebError, type FetchImpl } from '../../web/net'

export { decodeEntities, htmlToArticle, MAX_ARTICLE_CHARS } from '../../web/extract'
export { isPrivateHost } from '../../web/net'

export const MAX_PAGE_BYTES = 2 * 1024 * 1024

export type FetchLike = FetchImpl

export class ImportError extends Error {}

/** The importer's wording for a policy or fetch refusal. */
function importMessage(e: unknown): string | null {
  if (e instanceof WebError) {
    if (e.code === 'E_ROBOTS') return e.message
    if (e.code === 'E_TOO_LARGE') return 'the page is too large'
    return 'too many redirects'
  }
  if (e instanceof SafetyError) {
    const m = e.message
    if (/only https|scheme/.test(m)) return 'only https pages can be imported'
    if (/credentials/.test(m)) return 'addresses with a password are not imported'
    if (/local address/.test(m)) return 'local and private addresses are not imported'
    return 'that is not a web address'
  }
  return null
}

/** The page's HTML after robots and redirect checks. Throws ImportError with a reason. */
export async function fetchPage(
  raw: string,
  fetch: FetchLike,
  signal?: AbortSignal
): Promise<{ url: string; html: string }> {
  try {
    const res = await safeGet(raw, {
      fetch,
      signal,
      robots: true,
      maxBytes: MAX_PAGE_BYTES,
      overflow: 'throw',
      accept: 'text/html,application/xhtml+xml'
    })
    if (res.status < 200 || res.status >= 300)
      throw new ImportError(`the page answered ${res.status}`)
    if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType))
      throw new ImportError('that address is not a web page')
    return { url: res.url, html: res.body }
  } catch (e) {
    const msg = importMessage(e)
    if (msg) throw new ImportError(msg)
    throw e
  }
}
