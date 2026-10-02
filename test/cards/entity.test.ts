// Entity cards (05 T42): Wikipedia summaries through a fake network, and the background lookup
// that adds them (with the description as subtitle) and saves the set again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswerCards } from '../../src/shared/cards'
import { presentCards, setCardsPorts, store } from '../../src/main/cards'
import { clipSentences, wikiLang, wikiSummary } from '../../src/main/cards/entity'
import { findCardImages, setImageFinder } from '../../src/main/cards/find-images'
import type { Get } from '../../src/main/cards/images'

const json = (body: unknown, status = 200): ReturnType<Get> =>
  Promise.resolve({
    status,
    url: 'https://en.wikipedia.org/x',
    contentType: 'application/json',
    body: JSON.stringify(body)
  } as Awaited<ReturnType<Get>>)

const MONET = {
  type: 'standard',
  title: 'Claude Monet',
  description: 'French painter (1840–1926)',
  extract:
    'Oscar-Claude Monet was a French painter and founder of impressionist painting. He is seen as a key precursor to modernism.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Claude_Monet' } }
}

afterEach(() => {
  setImageFinder(null)
  setCardsPorts(null)
})

describe('wikiSummary', () => {
  it('reads the summary, link and description', async () => {
    const get = vi.fn<Get>(() => json(MONET))
    const r = await wikiSummary('Claude Monet', 'en', get)
    expect(get.mock.calls[0][0]).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Claude_Monet?redirect=true'
    )
    expect(r).toEqual({
      summary: {
        text: MONET.extract,
        url: 'https://en.wikipedia.org/wiki/Claude_Monet',
        source: 'Wikipedia'
      },
      description: 'French painter (1840–1926)'
    })
  })

  it('uses the voice language wiki and English otherwise', async () => {
    const get = vi.fn<Get>(() => json(MONET))
    await wikiSummary('Claude Monet', 'nl', get)
    expect(get.mock.calls[0][0]).toMatch(/^https:\/\/nl\.wikipedia\.org\//)
    expect(wikiLang('de-DE')).toBe('de')
    expect(wikiLang('ja')).toBe('en')
    expect(wikiLang(undefined)).toBe('en')
  })

  it('no summary for disambiguation pages, misses and errors', async () => {
    await expect(
      wikiSummary('Mercury', 'en', () => json({ ...MONET, type: 'disambiguation' }))
    ).resolves.toBeNull()
    await expect(wikiSummary('Nope', 'en', () => json({}, 404))).resolves.toBeNull()
    await expect(
      wikiSummary('X', 'en', () => Promise.reject(new Error('offline')))
    ).resolves.toBeNull()
    await expect(wikiSummary('  ', 'en', () => json(MONET))).resolves.toBeNull()
  })

  it('clips to whole sentences', () => {
    expect(clipSentences('One two. Three four. Five.', 12)).toBe('One two.')
    expect(clipSentences('Short.', 50)).toBe('Short.')
    expect(clipSentences('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('entity lookup after showing', () => {
  it('adds the summary and description, refreshes and saves the set', async () => {
    setCardsPorts(null, { resolve: async () => null })
    const cards: AnswerCards = {
      layout: 'carousel',
      sources: [],
      cards: [
        { id: 'e1', kind: 'entity', title: 'Claude Monet', facts: [], links: [], actions: [] },
        { id: 'p1', kind: 'product', title: 'Kettle', facts: [], links: [], actions: [] }
      ]
    }
    const shown = presentCards('Monet', cards, { show: false })
    if (!shown.ok) throw new Error(shown.error)
    const summary = vi.fn(async () => ({
      summary: {
        text: 'A painter.',
        url: 'https://en.wikipedia.org/wiki/Claude_Monet',
        source: 'Wikipedia'
      },
      description: 'French painter'
    }))
    setImageFinder({
      fromPage: async () => null,
      commons: async () => null,
      resolve: async () => null,
      summary
    })
    const persist = vi.spyOn(store, 'persist')
    await findCardImages(shown.id)
    expect(summary).toHaveBeenCalledTimes(1)
    const v = store.view(shown.id)!
    expect(v.cards[0].summary?.text).toBe('A painter.')
    expect(v.cards[0].subtitle).toBe('French painter')
    expect(v.cards[1].summary).toBeUndefined()
    expect(persist).toHaveBeenCalledWith(shown.id)
    persist.mockRestore()
  })

  it('a found picture ref too long to save again is not kept', async () => {
    setCardsPorts({
      showAnswer: vi.fn(),
      openUrl: vi.fn(),
      saveNote: vi.fn(),
      openPanel: vi.fn(),
      runQuery: vi.fn(),
      say: vi.fn()
    })
    const shown = presentCards('A place', {
      layout: 'carousel',
      sources: [],
      cards: [
        {
          id: 'p1',
          kind: 'place',
          title: 'Old Port',
          facts: [],
          links: [{ label: 'port.test', url: 'https://port.test/' }],
          actions: []
        }
      ]
    })
    if (!shown.ok) throw new Error(shown.error)
    const resolve = vi.fn(async () => 'data:image/jpeg;base64,AAAA')
    setImageFinder({
      fromPage: async () => ({
        sourceUrl: `https://port.test/${'a'.repeat(3000)}.jpg`,
        pageUrl: 'https://port.test/',
        alt: 'Old Port'
      }),
      commons: async () => null,
      resolve
    })
    await findCardImages(shown.id)
    expect(resolve).not.toHaveBeenCalled()
    expect(store.get(shown.id)?.cards.cards[0].image).toBeUndefined()
  })
})
