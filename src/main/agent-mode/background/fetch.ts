// fetch_url for background tasks: the shared safe GET (web/net: https only, no local or private
// hosts by name or by resolved address, every redirect re-checked, size and time capped), HTML
// reduced to text. No robots.txt here: the task reads one page the user asked about.
import { htmlToText } from '../../web/extract'
import { FETCH_MAX_BYTES, pinnedFetch, safeGet, type FetchImpl } from '../../web/net'

export {
  assertFetchable,
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  isPrivateHost,
  makeSafeLookup,
  pinnedFetch,
  safeLookup,
  type FetchImpl,
  type Resolver
} from '../../web/net'
export { htmlToText } from '../../web/extract'

export const FETCH_MAX_CHARS = 40_000

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

/** GET with every redirect hop checked again; HTML becomes text. */
export async function fetchPage(
  raw: string,
  signal: AbortSignal,
  impl: FetchImpl = pinnedFetch()
): Promise<FetchedPage> {
  const res = await safeGet(raw, {
    signal,
    fetch: impl,
    maxBytes: FETCH_MAX_BYTES,
    overflow: 'cut'
  })
  const { body, contentType } = res
  let text = /html|xml/.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body.trim()
  let truncated = res.cut
  if (text.length > FETCH_MAX_CHARS) {
    text = text.slice(0, FETCH_MAX_CHARS)
    truncated = true
  }
  return { url: res.url, status: res.status, contentType, text, truncated }
}
