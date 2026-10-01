import { describe, expect, it } from 'vitest'
import { configPatchSchema, WEB_DEFAULTS } from '@shared/config'
import {
  feedsToText,
  textToFeeds,
  textToInterests
} from '../../src/renderer/src/panel/settings/sections/news-feeds'

describe('Settings → News & reading feed text', () => {
  it('round-trips the default feeds', () => {
    expect(textToFeeds(feedsToText(WEB_DEFAULTS.feeds))).toEqual({
      feeds: WEB_DEFAULTS.feeds,
      bad: []
    })
  })

  it('names bare addresses, drops duplicates and reports bad lines', () => {
    const r = textToFeeds(
      [
        'https://www.example.org/feed.xml',
        '',
        'Local | http://example.org/rss | world',
        'Dup | https://www.example.org/feed.xml',
        'Science | https://sci.example.com/rss | Science',
        'not a feed'
      ].join('\n')
    )
    expect(r.feeds).toEqual([
      { name: 'example.org', url: 'https://www.example.org/feed.xml', topic: '' },
      { name: 'Science', url: 'https://sci.example.com/rss', topic: 'science' }
    ])
    expect(r.bad).toEqual([3, 6])
    expect(configPatchSchema.safeParse({ web: { feeds: r.feeds } }).success).toBe(true)
  })

  it('config refuses http feeds', () => {
    const bad = { web: { feeds: [{ name: 'x', url: 'http://x.org/rss', topic: '' }] } }
    expect(configPatchSchema.safeParse(bad).success).toBe(false)
  })

  it('interests', () => {
    expect(textToInterests('climate, Formula 1,\nclimate , ')).toEqual(['climate', 'Formula 1'])
  })
})
