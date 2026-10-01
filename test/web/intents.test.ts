import { describe, expect, it } from 'vitest'
import { ordinal, parseWebIntent, type IntentContext } from '../../src/main/web/intents'

const none: IntentContext = { page: false, news: false, browser: false }
const browser: IntentContext = { ...none, browser: true }
const page: IntentContext = { ...none, page: true }
const news: IntentContext = { ...none, news: true }

describe('web intents', () => {
  it('summarize phrases', () => {
    for (const t of [
      'Summarize this page',
      'summarise this article for me',
      'TL;DR',
      'tldr',
      "what's this article about?",
      'What is this page about',
      'explain this page',
      'give me the gist of this page'
    ])
      expect(parseWebIntent(t, none), t).toEqual({ kind: 'summarize' })
  })

  it('a bare "summarize it" needs a browser or a page', () => {
    expect(parseWebIntent('summarize it', none)).toBeNull()
    expect(parseWebIntent('summarize it', browser)).toEqual({ kind: 'summarize' })
    expect(parseWebIntent('recap', page)).toEqual({ kind: 'summarize' })
  })

  it('news phrases, topics and queries', () => {
    expect(parseWebIntent('top news today', none)).toEqual({ kind: 'news' })
    expect(parseWebIntent("What's the news?", none)).toEqual({ kind: 'news' })
    expect(parseWebIntent('read me the headlines', none)).toEqual({ kind: 'news' })
    expect(parseWebIntent("what's happening in tech", none)).toEqual({
      kind: 'news',
      topic: 'tech'
    })
    expect(parseWebIntent('tech news', none)).toEqual({ kind: 'news', topic: 'tech' })
    expect(parseWebIntent('news about the Mars mission', none)).toEqual({
      kind: 'news',
      query: 'the mars mission'
    })
    expect(parseWebIntent('latest news on climate talks', none)).toEqual({
      kind: 'news',
      query: 'climate talks'
    })
  })

  it('ordinary questions are not web intents', () => {
    for (const t of [
      'what is the capital of France',
      'open notepad',
      'summarize my emails and send them to Bob',
      'open the second tab',
      'is it raining'
    ])
      expect(parseWebIntent(t, { page: true, news: true, browser: true }), t).toBeNull()
  })

  it('sources only with context', () => {
    expect(parseWebIntent('open the second one', none)).toBeNull()
    expect(parseWebIntent('open the second one', news)).toEqual({
      kind: 'open',
      which: { index: 1 }
    })
    expect(parseWebIntent('open the sources', page)).toEqual({ kind: 'open', which: { all: true } })
    expect(parseWebIntent('open all the sources', news)).toEqual({
      kind: 'open',
      which: { all: true }
    })
    expect(parseWebIntent('open the BBC one', news)).toEqual({
      kind: 'open',
      which: { name: 'bbc' }
    })
    expect(parseWebIntent('open the last story', news)).toEqual({
      kind: 'open',
      which: { index: -1 }
    })
    expect(parseWebIntent('show me where that came from', page)).toEqual({
      kind: 'open',
      which: { index: 0 }
    })
    expect(parseWebIntent('open source 3', news)).toEqual({ kind: 'open', which: { index: 2 } })
  })

  it('story and page follow-ups', () => {
    expect(parseWebIntent('tell me more about the second story', news)).toEqual({
      kind: 'story',
      index: 1
    })
    expect(parseWebIntent('what are people saying about it', news)).toEqual({
      kind: 'story',
      index: 'current'
    })
    expect(parseWebIntent('what does it say about pricing', page)).toEqual({
      kind: 'ask',
      question: 'what does it say about pricing'
    })
    expect(parseWebIntent('is this biased?', page)?.kind).toBe('ask')
    expect(parseWebIntent('read me the conclusion', page)?.kind).toBe('ask')
    expect(parseWebIntent("explain it like I'm 12", page)?.kind).toBe('ask')
    expect(parseWebIntent('is this biased?', none)).toBeNull()
    expect(parseWebIntent('is this biased?', browser)?.kind).toBe('ask')
  })

  it('save to notes', () => {
    expect(parseWebIntent('save this to my notes', page)).toEqual({ kind: 'save' })
    expect(parseWebIntent('save this to my notes', none)).toBeNull()
  })

  it('ordinals', () => {
    expect(ordinal('first')).toBe(0)
    expect(ordinal('3rd')).toBe(2)
    expect(ordinal('number 4')).toBe(3)
    expect(ordinal('last')).toBe(-1)
    expect(ordinal('0')).toBeNull()
    expect(ordinal('bbc')).toBeNull()
  })
})
