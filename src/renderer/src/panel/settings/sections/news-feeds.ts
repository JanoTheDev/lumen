// Settings → News & reading: the feed list as editable text, one feed per line
// "Name | https://address | topic". Pure (tested in test/web).
import type { NewsFeedConfig } from '@shared/config'

export const MAX_FEEDS = 40

export function feedsToText(feeds: NewsFeedConfig[]): string {
  return feeds.map((f) => [f.name, f.url, f.topic].filter(Boolean).join(' | ')).join('\n')
}

export interface ParsedFeeds {
  feeds: NewsFeedConfig[]
  /** 1-based line numbers that are not a feed. */
  bad: number[]
}

function httpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password
      ? u.href
      : null
  } catch {
    return null
  }
}

/** Lines → feeds. A line with only an address is named after its host; duplicates are dropped. */
export function textToFeeds(text: string): ParsedFeeds {
  const feeds: NewsFeedConfig[] = []
  const bad: number[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((line, i) => {
    const parts = line.split('|').map((p) => p.trim())
    if (!parts.some(Boolean)) return
    const urlAt = parts.findIndex((p) => /^https?:\/\//i.test(p))
    const url = urlAt >= 0 ? httpsUrl(parts[urlAt]) : null
    if (!url || url.length > 500) {
      bad.push(i + 1)
      return
    }
    if (seen.has(url) || feeds.length >= MAX_FEEDS) return
    seen.add(url)
    const rest = parts.filter((_, j) => j !== urlAt)
    const name = (rest[0] || new URL(url).hostname.replace(/^www\./, '')).slice(0, 60)
    feeds.push({ name, url, topic: (rest[1] ?? '').toLowerCase().slice(0, 30) })
  })
  return { feeds, bad }
}

/** "climate, formula 1" → ["climate", "formula 1"] (max 30, 60 chars each). */
export function textToInterests(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[,\n]/)) {
    const t = part.trim().slice(0, 60)
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out.slice(0, 30)
}
