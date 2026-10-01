// News from the user's feeds (05 T31): fetch every feed (robots.txt respected, 10 min memory
// cache, nothing in the background), group the same story told by several outlets, rank by
// outlets, freshness and the user's interests, keep the top 5. No Electron.
import { parseFeed, type FeedItem, type NewsFeed } from './feeds'
import { safeGet, type FetchImpl, type RobotsCache } from './net'

export const TOP_STORIES = 5
const FEED_TTL_MS = 10 * 60_000
const FEED_MAX_BYTES = 2_000_000
const FEED_TIMEOUT_MS = 8000

export interface StorySource {
  name: string
  url: string
}

export interface Story {
  title: string
  summary: string
  /** Newest item time (ms), 0 = unknown. */
  published: number
  /** Distinct outlets, first = the item the title came from. */
  sources: StorySource[]
}

const STOP = new Set(
  'the a an and or of to in on for with at by from as is are was were be been it its this that these those after before over under into about than then new says say said will would could can has have had not no but more most how why what who when where which live update updates video watch'.split(
    ' '
  )
)

/** Content words of a headline (lowercase, ≥ 3 letters, no stop words). */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}

/** Groups items about the same event (headline word overlap), newest item first in each. */
export function cluster(items: FeedItem[], threshold = 0.3): Story[] {
  const sorted = [...items].sort((a, b) => b.published - a.published)
  const groups: { words: Set<string>; items: FeedItem[] }[] = []
  for (const item of sorted) {
    const w = words(item.title)
    let best: (typeof groups)[number] | null = null
    let bestScore = threshold
    for (const g of groups) {
      const s = jaccard(w, g.words)
      if (s >= bestScore) {
        best = g
        bestScore = s
      }
    }
    if (best) best.items.push(item)
    else groups.push({ words: w, items: [item] })
  }
  return groups.map((g) => {
    const first = g.items[0]
    const seen = new Set<string>()
    const sources: StorySource[] = []
    for (const i of g.items) {
      if (seen.has(i.source) || !i.url) continue
      seen.add(i.source)
      sources.push({ name: i.source, url: i.url })
    }
    return {
      title: first.title,
      summary: g.items.find((i) => i.summary)?.summary ?? '',
      published: first.published,
      sources
    }
  })
}

/** Whether a story is about the query (every query word, or most of a long query). */
export function matchesQuery(story: Story, query: string): boolean {
  const q = [...words(query)]
  if (!q.length) return true
  const hay = words(`${story.title} ${story.summary}`)
  const hits = q.filter((w) => hay.has(w) || [...hay].some((h) => h.startsWith(w))).length
  return q.length <= 2 ? hits === q.length : hits / q.length >= 0.6
}

export interface RankOptions {
  now: number
  interests?: string[]
  query?: string
  limit?: number
}

/** The top stories: more outlets, fresher and matching an interest rank higher. */
export function rankStories(stories: Story[], opts: RankOptions): Story[] {
  const interests = (opts.interests ?? []).map((i) => i.trim()).filter(Boolean)
  const pool = opts.query ? stories.filter((s) => matchesQuery(s, opts.query!)) : stories
  const score = (s: Story): number => {
    const ageH = s.published ? Math.max(0, (opts.now - s.published) / 3_600_000) : 36
    const fresh = Math.max(0, 1 - ageH / 48)
    const liked = interests.filter((i) => matchesQuery(s, i)).length
    return (s.sources.length - 1) * 2 + fresh * 2 + liked * 2.5
  }
  return pool
    .filter((s) => s.sources.length)
    .map((s) => ({ s, v: score(s) }))
    .sort((a, b) => b.v - a.v || b.s.published - a.s.published)
    .slice(0, opts.limit ?? TOP_STORIES)
    .map((x) => x.s)
}

export interface FeedFetchDeps {
  fetch?: FetchImpl
  robotsCache?: RobotsCache
  now?: () => number
  log?: (msg: string) => void
}

const feedCache = new Map<string, { items: FeedItem[]; at: number }>()

/** Forget cached feeds (tests, or a feed list edit). */
export function clearFeedCache(): void {
  feedCache.clear()
}

/** Items of every feed (failed feeds are skipped and logged); cached for 10 minutes. */
export async function fetchFeeds(
  feeds: NewsFeed[],
  signal: AbortSignal,
  deps: FeedFetchDeps = {}
): Promise<{ items: FeedItem[]; failed: string[] }> {
  const now = deps.now ?? Date.now
  const failed: string[] = []
  const lists = await Promise.all(
    feeds.map(async (f) => {
      const hit = feedCache.get(f.url)
      if (hit && now() - hit.at < FEED_TTL_MS) return hit.items
      try {
        const res = await safeGet(f.url, {
          signal,
          fetch: deps.fetch,
          robots: true,
          robotsCache: deps.robotsCache,
          maxBytes: FEED_MAX_BYTES,
          overflow: 'cut',
          timeoutMs: FEED_TIMEOUT_MS,
          accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9',
          now
        })
        if (res.status < 200 || res.status >= 300) throw new Error(`status ${res.status}`)
        const items = parseFeed(res.body, f.name, res.url)
        if (!items.length) throw new Error('no items')
        feedCache.set(f.url, { items, at: now() })
        return items
      } catch (e) {
        if (signal.aborted) throw e
        failed.push(f.name)
        deps.log?.(`news: ${f.name} skipped (${(e as Error).message})`)
        return []
      }
    })
  )
  return { items: lists.flat(), failed }
}

/** Feeds for a topic ("tech"); every feed when none has it. */
export function feedsFor(feeds: NewsFeed[], topic?: string): NewsFeed[] {
  if (!topic) return feeds
  const some = feeds.filter((f) => f.topic.toLowerCase() === topic.toLowerCase())
  return some.length ? some : feeds
}
