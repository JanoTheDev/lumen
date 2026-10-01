// What the user and Lumen were just reading (05 T34): the last page summary or news list, kept
// in memory for follow-ups ("what does it say about X", "open the second one") for 15 minutes,
// and fetched pages cached by URL for 15 minutes. Nothing is written to disk. No Electron.
import type { Story, StorySource } from './news'

export const CONTEXT_TTL_MS = 15 * 60_000

export type PageSource = 'screen' | 'fetch' | 'ocr'

export interface PageRead {
  title: string
  /** https address when known (address bar or fetch), '' otherwise. */
  url: string
  site: string
  text: string
  /** screen: the browser's own document text; fetch: downloaded; ocr: the visible part only. */
  source: PageSource
}

export interface PageContext extends PageRead {
  summary: string
  keyPoints: string[]
}

export interface WebState {
  page: PageContext | null
  news: Story[] | null
  /** The story the last answer was about (news follow-ups, "save this"). */
  story: number
  /** Numbered citations of the last web answer, in card order. */
  sources: StorySource[]
  /** What "save this to my notes" saves. */
  lastAnswer: { title: string; text: string; url: string } | null
  at: number
}

const empty = (): WebState => ({
  page: null,
  news: null,
  story: 0,
  sources: [],
  lastAnswer: null,
  at: 0
})

let state: WebState = empty()

/** The current web context, or an empty one once it is older than 15 minutes. */
export function webState(now = Date.now()): WebState {
  if (state.at && now - state.at > CONTEXT_TTL_MS) state = empty()
  return state
}

export function setPageContext(page: PageContext, now = Date.now()): void {
  const sources = page.url ? [{ name: page.site || hostOf(page.url), url: page.url }] : []
  state = {
    ...empty(),
    page,
    sources,
    lastAnswer: { title: page.title, text: page.summary, url: page.url },
    at: now
  }
}

export function setNewsContext(stories: Story[], now = Date.now()): void {
  state = {
    ...empty(),
    news: stories,
    sources: stories.flatMap((s) => s.sources.slice(0, 1)),
    lastAnswer: null,
    at: now
  }
}

/** Updates what the last answer was (a story brief, a page answer) and keeps the context fresh. */
export function touchContext(patch: Partial<WebState>, now = Date.now()): void {
  state = { ...state, ...patch, at: now }
}

export function clearWebContext(): void {
  state = empty()
  pageCache.clear()
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const pageCache = new Map<string, { page: PageRead; at: number }>()

export function cachedPage(url: string, now = Date.now()): PageRead | null {
  const hit = pageCache.get(url)
  if (!hit) return null
  if (now - hit.at > CONTEXT_TTL_MS) {
    pageCache.delete(url)
    return null
  }
  return hit.page
}

export function cachePage(url: string, page: PageRead, now = Date.now()): void {
  pageCache.set(url, { page, at: now })
  // Keep the cache small: the oldest entries go first.
  while (pageCache.size > 20) pageCache.delete(pageCache.keys().next().value as string)
}
