import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { WEB_DEFAULTS } from '@shared/config'
import { parseFeed } from '../../src/main/web/feeds'
import {
  clearFeedCache,
  cluster,
  feedsFor,
  fetchFeeds,
  matchesQuery,
  rankStories
} from '../../src/main/web/news'
import type { FetchImpl } from '../../src/main/web/net'
import { newsCard, ago } from '../../src/main/web/cards'

const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const NOW = Date.parse('2026-10-01T10:00:00Z')

describe('feeds', () => {
  it('parses RSS with CDATA, escaped HTML and dates; drops non-https links', () => {
    const items = parseFeed(fx('world.rss.xml'), 'World Desk', 'https://world.test/rss')
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({
      title: 'Leaders agree climate deal at summit in Nairobi',
      url: 'https://world.test/news/climate-deal',
      summary:
        'Leaders from 120 countries agreed a climate deal on Tuesday. The deal cuts emissions.',
      published: Date.parse('2026-10-01T08:00:00Z'),
      source: 'World Desk'
    })
    expect(items[2].url).toBe('')
  })

  it('parses Atom with the alternate link', () => {
    const items = parseFeed(fx('tech.atom.xml'), 'Tech Wire', 'https://tech.test/feed')
    expect(items.map((i) => i.url)).toEqual([
      'https://tech.test/2026/10/climate-deal',
      'https://tech.test/2026/10/chip'
    ])
    expect(items[0].summary).toBe('Nairobi summit ends with a deal on emissions.')
    expect(items[1].summary).toBe('A RISC-V laptop chip is now shipping.')
  })

  it('anything else gives no items', () => {
    expect(parseFeed('<html><body>hi</body></html>', 'x', 'https://x.test/')).toEqual([])
  })

  it('default feeds are https and pass the config schema', () => {
    expect(WEB_DEFAULTS.feeds.length).toBeGreaterThan(3)
    for (const f of WEB_DEFAULTS.feeds) expect(f.url).toMatch(/^https:\/\//)
    expect(WEB_DEFAULTS.feeds.some((f) => /news\.google\./.test(f.url))).toBe(false)
    expect(WEB_DEFAULTS.paidSearch).toBe(false)
  })
})

describe('clustering and ranking', () => {
  const items = [
    ...parseFeed(fx('world.rss.xml'), 'World Desk', 'https://world.test/'),
    ...parseFeed(fx('tech.atom.xml'), 'Tech Wire', 'https://tech.test/')
  ]

  it('groups the same story from two outlets', () => {
    const stories = cluster(items)
    const climate = stories.find((s) => /climate/i.test(s.title))!
    expect(climate.sources.map((s) => s.name)).toEqual(['Tech Wire', 'World Desk'])
    expect(stories).toHaveLength(4)
  })

  it('ranks multi-outlet and interesting stories first, drops link-less ones', () => {
    const top = rankStories(cluster(items), { now: NOW })
    expect(top[0].title).toMatch(/climate/i)
    expect(top.some((s) => /ignore previous/i.test(s.title))).toBe(false)
    const liked = rankStories(cluster(items), { now: NOW, interests: ['laptop chip'] })
    expect(liked[0].title).toMatch(/chip/)
  })

  it('filters by query', () => {
    const stories = cluster(items)
    expect(rankStories(stories, { now: NOW, query: 'rail strike' }).map((s) => s.title)).toEqual([
      'Rail strike disrupts commuters across the region'
    ])
    expect(rankStories(stories, { now: NOW, query: 'volcano' })).toEqual([])
    expect(matchesQuery(stories[0], '')).toBe(true)
  })

  it('topic feeds, else all', () => {
    const feeds = [
      { name: 'A', url: 'https://a.test/rss', topic: 'world' },
      { name: 'B', url: 'https://b.test/rss', topic: 'tech' }
    ]
    expect(feedsFor(feeds, 'tech').map((f) => f.name)).toEqual(['B'])
    expect(feedsFor(feeds, 'sports')).toHaveLength(2)
  })

  it('news card numbers stories and links sources', () => {
    const top = rankStories(cluster(items), { now: NOW, limit: 2 })
    const card = newsCard(
      top.map((story) => ({ story, brief: 'Brief.' })),
      NOW,
      'Top news'
    )
    expect(card).toContain('1. **')
    expect(card).toContain('[1](https://tech.test/2026/10/climate-deal) Tech Wire')
    expect(card).toContain('[2](')
    expect(ago(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago')
  })
})

describe('fetchFeeds', () => {
  beforeEach(() => clearFeedCache())

  const serve =
    (calls: string[]): FetchImpl =>
    async (url) => {
      calls.push(url)
      if (url.endsWith('/robots.txt'))
        return url.startsWith('https://blocked.test')
          ? new Response('User-agent: *\nDisallow: /', { status: 200 })
          : new Response('', { status: 404 })
      if (url === 'https://world.test/rss')
        return new Response(fx('world.rss.xml'), {
          headers: { 'content-type': 'application/rss+xml' }
        })
      return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
    }

  it('reads feeds, respects robots, skips broken ones and caches', async () => {
    const calls: string[] = []
    const log: string[] = []
    const feeds = [
      { name: 'World', url: 'https://world.test/rss', topic: 'world' },
      { name: 'Blocked', url: 'https://blocked.test/rss', topic: 'world' },
      { name: 'Down', url: 'https://down.test/rss', topic: 'tech' }
    ]
    const sig = new AbortController().signal
    const r = await fetchFeeds(feeds, sig, {
      fetch: serve(calls),
      now: () => NOW,
      log: (m) => log.push(m)
    })
    expect(r.items).toHaveLength(3)
    expect(r.failed.sort()).toEqual(['Blocked', 'Down'])
    expect(calls).not.toContain('https://blocked.test/rss')
    const again = await fetchFeeds(feeds.slice(0, 1), sig, {
      fetch: serve(calls),
      now: () => NOW + 1000
    })
    expect(again.items).toHaveLength(3)
    expect(calls.filter((c) => c === 'https://world.test/rss')).toHaveLength(1)
  })
})
