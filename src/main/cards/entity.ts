// Entity cards (05 T42): a person, place or thing gets a short Wikipedia summary with its link
// (and the one-line description as the subtitle when the card has none). Wikipedia's REST
// summary is a free API for programs, like the MediaWiki API the images use, so no robots.txt
// check; requests carry Lumen's user agent through web/net safeGet.
import { CARD_LIMITS, type CardSummary } from '@shared/cards'
import { safeGet } from '../web/net'
import type { Get } from './images'

export const WIKI_LANGS = ['en', 'nl', 'de', 'fr', 'es'] as const

export interface WikiSummary {
  summary: CardSummary
  /** One line ("French painter (1840–1926)"), or ''. */
  description: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Whole sentences up to `max` characters (one cut sentence when the first is longer). */
export function clipSentences(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? []
  let out = ''
  for (const s of sentences) {
    if ((out + s).trim().length > max) break
    out += s
  }
  out = out.trim()
  return out || `${t.slice(0, max - 1).trimEnd()}…`
}

/** The wiki language for the voice language ("nl" → nl.wikipedia.org), else English. */
export function wikiLang(lang: string | undefined): string {
  const l = (lang ?? '').toLowerCase().split('-')[0]
  return (WIKI_LANGS as readonly string[]).includes(l) ? l : 'en'
}

/** The article's summary, or null (no article, a disambiguation page, blocked, offline). */
export async function wikiSummary(
  title: string,
  lang = 'en',
  get: Get = safeGet,
  signal?: AbortSignal
): Promise<WikiSummary | null> {
  const t = title.trim().slice(0, 200)
  if (!t) return null
  const url = `https://${wikiLang(lang)}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`
  try {
    const res = await get(url, {
      signal,
      accept: 'application/json',
      maxBytes: 200_000,
      timeoutMs: 8_000
    })
    if (res.status !== 200) return null
    const j = obj(JSON.parse(res.body))
    if (str(j.type) !== 'standard') return null
    const extract = clipSentences(str(j.extract), CARD_LIMITS.summary)
    const page = str(obj(obj(j.content_urls).desktop).page)
    if (!extract || !page.startsWith('https://')) return null
    const description = str(j.description)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CARD_LIMITS.subtitle)
    return { summary: { text: extract, url: page, source: 'Wikipedia' }, description }
  } catch {
    return null
  }
}
