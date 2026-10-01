// RSS 2.0 / Atom → items, with a tiny tag reader (no XML dependency). The default feeds
// (WEB_DEFAULTS in @shared/config) are free publisher feeds only. Google News RSS is not used:
// its robots.txt disallows /rss for every agent and its terms allow the feeds only in a
// personal feed reader, without reformatting (checked 2026-10-01). No Electron.
import type { NewsFeedConfig } from '@shared/config'
import { decodeEntities, htmlToText } from './extract'

export type NewsFeed = NewsFeedConfig

export interface FeedItem {
  title: string
  /** https link to the story ('' when the feed gave none usable). */
  url: string
  /** Plain text, at most 400 chars. */
  summary: string
  /** ms since epoch; 0 = unknown. */
  published: number
  source: string
}

const MAX_SUMMARY = 400
const MAX_ITEMS = 60

function inner(block: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  if (!m) return ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1])
  return cdata ? cdata[1] : m[1]
}

function text(raw: string): string {
  // Feed text is often entity-escaped HTML: decode once, then strip tags.
  const once = /<[a-z]/i.test(raw) ? raw : decodeEntities(raw)
  return htmlToText(once).replace(/\s+/g, ' ').trim()
}

function httpsLink(raw: string, base: string): string {
  try {
    const u = new URL(decodeEntities(raw.trim()), base)
    return u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

function atomLink(entry: string, base: string): string {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1])
  const alt =
    links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a))
  const href = alt && /href=["']([^"']+)["']/i.exec(alt)?.[1]
  return href ? httpsLink(href, base) : ''
}

function date(raw: string): number {
  const t = Date.parse(raw.trim())
  return Number.isFinite(t) ? t : 0
}

/** The items of an RSS or Atom document ([] when it is neither). */
export function parseFeed(xml: string, source: string, base: string): FeedItem[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const rss = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1])
  const atom = rss.length ? [] : [...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)]
  const out: FeedItem[] = []
  for (const item of rss) {
    out.push({
      title: text(inner(item, 'title')),
      url: httpsLink(text(inner(item, 'link')) || inner(item, 'guid'), base),
      summary: text(inner(item, 'description')).slice(0, MAX_SUMMARY),
      published: date(inner(item, 'pubDate') || inner(item, 'dc:date')),
      source
    })
  }
  for (const [, entry] of atom) {
    out.push({
      title: text(inner(entry, 'title')),
      url: atomLink(entry, base),
      summary: text(inner(entry, 'summary') || inner(entry, 'content')).slice(0, MAX_SUMMARY),
      published: date(inner(entry, 'updated') || inner(entry, 'published')),
      source
    })
  }
  return out.filter((i) => i.title).slice(0, MAX_ITEMS)
}
