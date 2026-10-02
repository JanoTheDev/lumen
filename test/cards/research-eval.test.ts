// Research → cards eval (05 T39): recorded pages served by a fake safe GET, a scripted model
// (no live model in CI) and the real runner, fetch_url and present_cards handlers. Proves that
// only prices / ratings read on a page this task fetched reach the cards.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import { runAgent, type RunnerDeps } from '../../src/main/agent-mode/runner'
import { cardsForAnswer, cardsView, currentCards, setCardsPorts, store } from '../../src/main/cards'
import { FETCH_URL_TOOL, fetchUrlHandler } from '../../src/main/cards/fetch-tool'
import { presentCardsHandler } from '../../src/main/cards/present-tool'
import { PRESENT_CARDS_TOOL } from '../../src/main/cards/research'
import type { SafeGetOptions, SafeGetResult } from '../../src/main/web/net'

const PAGES: Record<string, string> = {
  'https://hotels.test/nice': 'hotels-nice.html',
  'https://hotels.test/azur': 'hotel-azur.html'
}
const page = (f: string): string => readFileSync(join(__dirname, 'pages', f), 'utf8')

const fakeGet = vi.fn(async (url: string, opts: SafeGetOptions): Promise<SafeGetResult> => {
  expect(opts.robots).toBe(true)
  const file = PAGES[url]
  if (!file) return { url, status: 404, contentType: 'text/html', body: '', cut: false }
  return { url, status: 200, contentType: 'text/html', body: page(file), cut: false }
})

const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
let n = 0
const turn = (...calls: Omit<ToolCall, 'id'>[]): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls: calls.map((c) => ({ ...c, id: `k${++n}` })) },
  usage,
  model: 'fake',
  stopReason: 'tool_use'
})

const CARDS = {
  text: 'I found 3 hotels in Nice. The cheapest is Old Town Rooms at 95 euros a night.',
  layout: 'carousel',
  sources: [
    { id: 's1', title: 'hotels.test', url: 'https://hotels.test/nice' },
    { id: 's2', title: 'deals.test', url: 'https://deals.test/nice' }
  ],
  cards: [
    {
      kind: 'lodging',
      title: 'Hotel Azur',
      subtitle: 'Promenade des Anglais',
      link: 'https://hotels.test/azur',
      price: [{ amount: 140, currency: 'EUR', unit: 'night', note: '3–5 May', sourceId: 's1' }],
      rating: [{ value: 4.4, max: 5, count: 1203, sourceId: 's1' }],
      facts: [{ label: 'Beach', value: '2 min walk' }],
      badges: ['Free parking'],
      doLabel: 'Book it'
    },
    {
      kind: 'lodging',
      title: 'Old Town Rooms',
      subtitle: 'Vieux Nice',
      link: 'https://hotels.test/old-town',
      // Read on the page: kept.
      price: [{ amount: 95, currency: 'EUR', unit: 'night', note: '', sourceId: 's1' }],
      // Never read anywhere: dropped.
      rating: [{ value: 9.2, max: 10, count: 0, sourceId: 's1' }],
      facts: [],
      badges: [],
      doLabel: ''
    },
    {
      kind: 'lodging',
      title: 'Villa Cimiez',
      subtitle: 'Cimiez hills',
      link: 'https://hotels.test/cimiez',
      // "Price on request" on the page; this one comes from a site the task never opened.
      price: [{ amount: 120, currency: 'EUR', unit: 'night', note: '', sourceId: 's2' }],
      rating: [],
      facts: [{ label: 'Class', value: '4-star' }],
      badges: [],
      doLabel: ''
    }
  ],
  filters: [{ label: 'Near the beach', match: 'beach' }]
}

function deps(script: ToolTurnResult[], background = false): RunnerDeps {
  let i = 0
  return {
    model: {
      plan: async () => ({ plan: null }),
      turn: async () => script[Math.min(i++, script.length - 1)]
    },
    handlers: {
      fetch_url: fetchUrlHandler({ get: fakeGet }),
      present_cards: presentCardsHandler({
        background,
        findImages: async () => {},
        now: () => 1_000
      })
    },
    publish: () => {},
    speak: () => {},
    countdown: async () => 'go',
    askContinue: async () => false,
    costOf: () => 0,
    now: () => Date.now()
  }
}

const opts = {
  prompt: 'research hotels in Nice for 3 to 5 May',
  context: {},
  tools: ['ask_user', 'finish'] as const,
  extraTools: [FETCH_URL_TOOL, PRESENT_CARDS_TOOL],
  cancelWindowMs: 0,
  skipPlan: true,
  speakSummary: false
}

afterEach(() => setCardsPorts(null))

describe('research → cards eval', () => {
  it('keeps only prices and ratings read on fetched pages', async () => {
    const showAnswer = vi.fn()
    setCardsPorts({
      showAnswer,
      openUrl: vi.fn(),
      saveNote: vi.fn(),
      openPanel: vi.fn(),
      runQuery: vi.fn(),
      say: vi.fn()
    })
    const r = await runAgent(
      opts,
      deps([
        turn({ name: 'fetch_url', input: { url: 'https://hotels.test/nice' } }),
        turn({ name: 'present_cards', input: CARDS }),
        turn({ name: 'finish', input: { summary: 'should not get here' } })
      ])
    )
    expect(r.status).toBe('done')
    expect(r.summary).toBe(CARDS.text)
    expect(r.cardsId).toBeTruthy()
    expect(showAnswer).toHaveBeenCalledWith(CARDS.text, r.cardsId)
    expect(cardsForAnswer(CARDS.text)).toBe(r.cardsId)
    const view = cardsView(r.cardsId!)!
    const [azur, old, villa] = view.cards
    expect(azur.price).toMatchObject({ amount: 140, note: 'from hotels.test, 3–5 May, may change' })
    expect(azur.rating).toMatchObject({ value: 4.4, max: 5 })
    expect(old.price).toMatchObject({ amount: 95 })
    expect(old.rating).toBeUndefined()
    expect(villa.price).toBeUndefined()
    expect(view.sources.map((s) => s.url)).toEqual(['https://hotels.test/nice'])
    expect(store.get(r.cardsId!)?.request).toBe(opts.prompt)
    expect(currentCards()?.id).toBe(r.cardsId)
  })

  it('without any page read, every price and rating goes', async () => {
    const r = await runAgent(opts, deps([turn({ name: 'present_cards', input: CARDS })]))
    const view = cardsView(r.cardsId!)!
    expect(view.cards.some((c) => c.price || c.rating)).toBe(false)
    expect(view.cards.map((c) => c.title)).toEqual(['Hotel Azur', 'Old Town Rooms', 'Villa Cimiez'])
  })

  it('a background run stores the cards without showing them or making them current', async () => {
    const showAnswer = vi.fn()
    setCardsPorts({
      showAnswer,
      openUrl: vi.fn(),
      saveNote: vi.fn(),
      openPanel: vi.fn(),
      runQuery: vi.fn(),
      say: vi.fn()
    })
    const before = currentCards()?.id
    const r = await runAgent(
      opts,
      deps(
        [
          turn({ name: 'fetch_url', input: { url: 'https://hotels.test/nice' } }),
          turn({ name: 'present_cards', input: CARDS })
        ],
        true
      )
    )
    expect(r.cardsId).toBeTruthy()
    expect(showAnswer).not.toHaveBeenCalled()
    expect(currentCards()?.id).toBe(before)
    expect(cardsView(r.cardsId!)?.cards).toHaveLength(3)
  })

  it('a refused set goes back to the model, which can fix it', async () => {
    const r = await runAgent(
      opts,
      deps([
        turn({ name: 'present_cards', input: { ...CARDS, cards: [] } }),
        turn({ name: 'finish', input: { summary: 'No options found.' } })
      ])
    )
    expect(r.cardsId).toBeUndefined()
    expect(r.summary).toBe('No options found.')
  })
  it('keeps the user words as the set request, not a goal that quotes card text', async () => {
    const d = deps([turn({ name: 'present_cards', input: CARDS })])
    d.handlers.present_cards = presentCardsHandler({
      background: false,
      findImages: async () => {},
      request: () => 'hotels in Nice. cheaper ones'
    })
    const r = await runAgent({ ...opts, prompt: 'hotels in Nice. Only cheaper than Old Town' }, d)
    expect(store.get(r.cardsId!)?.request).toBe('hotels in Nice. cheaper ones')
  })
})
