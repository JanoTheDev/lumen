// One "read the web with me" turn (05 T29–T34): summarize / ask about the page in front, the
// news from the user's feeds, more on a story, open the numbered sources, save to notes.
// Returns null when the utterance is not a web request (the normal pipeline runs). Every
// outside effect is a port, so the flow is tested with fixtures and no network.
import type { WebConfig } from '@shared/config'
import type { ModelResponse } from '@shared/types'
import { newsCard, pageCard, answerCard, storyCard, type Brief } from './cards'
import {
  hostOf,
  setNewsContext,
  setPageContext,
  touchContext,
  webState,
  type PageContext,
  type PageRead
} from './context'
import { parseWebIntent, type SourcePick, type WebIntent } from './intents'
import { cluster, feedsFor, fetchFeeds, rankStories, type Story, type StorySource } from './news'
import type { FetchImpl, RobotsCache } from './net'
import { noteSaver } from './notes'
import { acquirePage, readUrl, type PagePorts } from './page'
import type { SearchAnswer } from './search'
import {
  askPage,
  briefNews,
  firstSentences,
  summarizePage,
  type Complete,
  type Style
} from './summarize'

export interface WebDeps {
  web(): WebConfig
  style(): Style
  /** The foreground window is a browser (asked only for "summarize it"-style phrases). */
  browserFront(): Promise<boolean>
  page: PagePorts
  complete: Complete
  feedFetch?: FetchImpl
  robotsCache?: RobotsCache
  /** Opens one https URL in the default browser through the safety policy; false = refused. */
  openUrl(url: string, userText: string, signal: AbortSignal): Promise<boolean>
  /** Paid search when the user turned it on and a key allows it; null otherwise. */
  paidSearch(query: string, signal: AbortSignal): Promise<SearchAnswer | null>
  now(): number
  log(msg: string): void
}

const MAX_OPEN = 5

const answer = (text: string, spoken = text): ModelResponse => ({ mode: 'answer', text, spoken })

/** The web intent, checking the foreground window only when the phrase needs a browser. */
async function intentFor(prompt: string, deps: WebDeps): Promise<WebIntent | null> {
  const st = webState(deps.now())
  const ctx = { page: !!st.page, news: !!st.news }
  const loose = parseWebIntent(prompt, { ...ctx, browser: true })
  if (!loose) return null
  const strict = parseWebIntent(prompt, { ...ctx, browser: false })
  if (strict) return strict
  return (await deps.browserFront().catch(() => false)) ? loose : null
}

export async function handleWebTurn(
  prompt: string,
  signal: AbortSignal,
  deps: WebDeps
): Promise<ModelResponse | null> {
  const intent = await intentFor(prompt, deps)
  if (!intent) return null
  deps.log(`web: ${intent.kind}`)
  switch (intent.kind) {
    case 'summarize':
      return summarize(signal, deps)
    case 'ask':
      return ask(intent.question, signal, deps)
    case 'news':
      return news(intent.query, intent.topic, signal, deps)
    case 'story':
      return story(intent.index, signal, deps)
    case 'open':
      return open(intent.which, prompt, signal, deps)
    case 'save':
      return save(deps)
  }
}

const NO_PAGE =
  'I couldn’t read a page in front. Open the article in your browser, click into it, and ask again.'

async function summarize(signal: AbortSignal, deps: WebDeps): Promise<ModelResponse> {
  const page = await acquirePage(deps.page, signal)
  if (!page) return answer(NO_PAGE)
  const sum = await summarizePage(page, deps.style(), deps.complete, signal)
  const ctx: PageContext = { ...page, summary: sum.summary, keyPoints: sum.keyPoints }
  setPageContext(ctx, deps.now())
  const visible = page.source === 'ocr' ? ' I only see the visible part of the page.' : ''
  return answer(pageCard(ctx), `${sum.spoken}${visible}`)
}

async function ask(question: string, signal: AbortSignal, deps: WebDeps): Promise<ModelResponse> {
  let page: PageRead | null = webState(deps.now()).page
  if (!page) {
    page = await acquirePage(deps.page, signal)
    if (!page) return answer(NO_PAGE)
    setPageContext({ ...page, summary: '', keyPoints: [] }, deps.now())
  }
  const out = await askPage(page, question, deps.style(), deps.complete, signal)
  if (!out)
    return answer(
      'I need an AI model to answer questions about the page. Add a key in Settings, Models & keys.'
    )
  touchContext({ lastAnswer: { title: page.title, text: out.text, url: page.url } }, deps.now())
  return answer(answerCard(out.text, page), out.spoken)
}

function newsHeading(query: string | undefined, topic: string | undefined): string {
  if (query) return `News about ${query}`
  if (topic) return `Top ${topic} news`
  return 'Top news'
}

async function news(
  query: string | undefined,
  topic: string | undefined,
  signal: AbortSignal,
  deps: WebDeps
): Promise<ModelResponse> {
  const cfg = deps.web()
  const feeds = feedsFor(cfg.feeds, topic)
  if (!feeds.length)
    return answer('You have no news feeds set. Add some in Settings, News & reading.')
  const { items, failed } = await fetchFeeds(feeds, signal, {
    fetch: deps.feedFetch,
    robotsCache: deps.robotsCache,
    now: deps.now,
    log: deps.log
  })
  const now = deps.now()
  const stories = rankStories(cluster(items), { now, interests: cfg.interests, query })
  const heading = newsHeading(query, topic)
  if (!stories.length) {
    if (query) {
      const paid = await deps.paidSearch(query, signal).catch((e: Error) => {
        if (signal.aborted) throw e
        deps.log(`web: paid search failed (${e.message})`)
        return null
      })
      if (paid?.text) return searched(query, paid, deps)
      const hint = cfg.paidSearch ? '' : ' You can turn on web search in Settings, News & reading.'
      return answer(`I found nothing about ${query} in your news feeds right now.${hint}`)
    }
    return answer(
      items.length
        ? 'I found no stories in your feeds right now.'
        : 'I couldn’t reach your news feeds right now. Check your connection and try again.'
    )
  }
  const { spoken, briefs } = await briefNews(stories, heading, deps.style(), deps.complete, signal)
  const list: Brief[] = stories.map((story, i) => ({ story, brief: briefs[i] ?? '' }))
  const note = failed.length ? `_Not reachable right now: ${failed.join(', ')}._` : ''
  const card = newsCard(list, now, heading, note)
  setNewsContext(stories, now)
  touchContext({ lastAnswer: { title: heading, text: card, url: '' } }, now)
  return answer(card, spoken)
}

/** A paid search answer becomes a one-story news context so its sources can be opened. */
function searched(query: string, paid: SearchAnswer, deps: WebDeps): ModelResponse {
  const now = deps.now()
  const story: Story = {
    title: `News about ${query}`,
    summary: paid.text,
    published: now,
    sources: paid.sources
  }
  setNewsContext([story], now)
  touchContext(
    {
      sources: paid.sources,
      lastAnswer: { title: story.title, text: paid.text, url: paid.sources[0]?.url ?? '' }
    },
    now
  )
  deps.log(`web: paid search (${paid.searches} searches)`)
  return answer(storyCard(story, paid.text), firstSentences(paid.text, 5, 700))
}

async function story(
  index: number | 'current',
  signal: AbortSignal,
  deps: WebDeps
): Promise<ModelResponse> {
  const st = webState(deps.now())
  const stories = st.news ?? []
  const i = index === 'current' ? st.story : index < 0 ? stories.length - 1 : index
  const s = stories[i]
  if (!s)
    return answer(
      `There ${stories.length === 1 ? 'is only one story' : `are only ${stories.length} stories`}.`
    )
  let text = ''
  let spoken = ''
  for (const src of s.sources.slice(0, 2)) {
    try {
      const page = await readUrl(src.url, deps.page, signal)
      if (page.text.length < 280) continue
      const sum = await summarizePage(page, deps.style(), deps.complete, signal)
      text = [sum.summary, ...sum.keyPoints.map((p) => `- ${p}`)].join('\n')
      spoken = sum.spoken
      break
    } catch (e) {
      signal.throwIfAborted()
      deps.log(`web: story ${src.name} not readable (${(e as Error).message})`)
    }
  }
  if (!text) {
    text = s.summary || 'The feed gave no more detail on this story.'
    spoken = `${s.title}. ${firstSentences(s.summary, 3)}`.trim()
    if (s.sources.length)
      text +=
        '\n\n_The article itself could not be read; say "open it" to read it in your browser._'
  }
  const others = s.sources.length > 1 ? ` ${s.sources.length} outlets carried it.` : ''
  touchContext(
    {
      story: i,
      sources: s.sources,
      lastAnswer: { title: s.title, text, url: s.sources[0]?.url ?? '' }
    },
    deps.now()
  )
  return answer(storyCard(s, text), `${spoken}${others}`)
}

function pickSources(which: SourcePick, deps: WebDeps): StorySource[] {
  const st = webState(deps.now())
  const all = st.sources
  if ('all' in which) return all.slice(0, MAX_OPEN)
  if ('index' in which) {
    const i = which.index < 0 ? all.length - 1 : which.index
    return all[i] ? [all[i]] : []
  }
  const name = which.name.toLowerCase().replace(/^the /, '')
  const pool = [...all, ...(st.news ?? []).flatMap((s) => s.sources)]
  const hit = pool.find(
    (s) => s.name.toLowerCase().includes(name) || hostOf(s.url).includes(name.replace(/\s+/g, ''))
  )
  return hit ? [hit] : []
}

async function open(
  which: SourcePick,
  prompt: string,
  signal: AbortSignal,
  deps: WebDeps
): Promise<ModelResponse> {
  const picked = pickSources(which, deps)
  if (!picked.length) {
    const n = webState(deps.now()).sources.length
    return answer(
      n
        ? `I have ${n} source${n === 1 ? '' : 's'}; say "open the first one" or "open all the sources".`
        : 'There is no source to open.'
    )
  }
  const opened: string[] = []
  for (const s of picked) {
    if (await deps.openUrl(s.url, prompt, signal)) opened.push(s.name || hostOf(s.url))
    signal.throwIfAborted()
  }
  if (!opened.length) return answer('I didn’t open it.')
  touchContext({}, deps.now())
  return answer(`Opening ${opened.join(', ')}.`)
}

async function save(deps: WebDeps): Promise<ModelResponse> {
  const st = webState(deps.now())
  const last = st.lastAnswer
  if (!last?.text.trim()) return answer('There is nothing to save yet.')
  const saver = noteSaver()
  if (!saver) return answer('Notes aren’t available yet, so I couldn’t save it.')
  const ok = await Promise.resolve(
    saver({ text: last.text, title: last.title || undefined, url: last.url || undefined })
  ).catch((e: Error) => {
    deps.log(`web: save to notes failed (${e.message})`)
    return false
  })
  return answer(ok ? 'Saved to your notes.' : 'I couldn’t save it to your notes.')
}
