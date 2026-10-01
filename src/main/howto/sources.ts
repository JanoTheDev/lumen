// Free how-to sources (05 T36). Microsoft Learn's public search (`/api/search`, JSON, no key;
// robots.txt allows it, checked 2026-10-01) for Microsoft apps and Windows, then the best
// article read with the shared safe GET (robots on) and its numbered steps extracted. Google's
// and Microsoft's support sites have no search endpoint that robots.txt allows, so their pages
// are only read when a paid search cites them. No Electron.
import { goalWords } from './notes'
import { stepsFromHtml } from './extract'
import type { HowtoSource, HowtoStep } from './types'

/** GET text through the shared safe GET (robots, size cap); throws on policy / robots / network. */
export type GetText = (
  url: string,
  accept: string,
  signal?: AbortSignal
) => Promise<{ url: string; status: number; body: string }>

export const LEARN_SEARCH = 'https://learn.microsoft.com/api/search'
const LEARN_TOP = 5
const ARTICLES_TRIED = 2

export interface LearnHit {
  title: string
  url: string
  description: string
}

export function learnSearchUrl(query: string, locale = 'en-us'): string {
  const q = new URLSearchParams({ search: query, locale, $top: String(LEARN_TOP) })
  return `${LEARN_SEARCH}?${q.toString()}`
}

/** Search hits from the Learn JSON (https learn.microsoft.com / support.microsoft.com only). */
export function parseLearn(json: string): LearnHit[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const results = (raw as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  const out: LearnHit[] = []
  for (const r of results as Record<string, unknown>[]) {
    const url = typeof r.url === 'string' ? r.url : ''
    if (!/^https:\/\/(learn|support)\.microsoft\.com\//.test(url)) continue
    out.push({
      title: typeof r.title === 'string' ? r.title.slice(0, 200) : url,
      url,
      description: typeof r.description === 'string' ? r.description.slice(0, 400) : ''
    })
  }
  return out
}

/** How well a hit matches the goal: share of the goal's words in its title + description. */
export function hitScore(hit: LearnHit, goal: string): number {
  const want = goalWords(goal)
  if (!want.size) return 0
  const have = goalWords(`${hit.title} ${hit.description}`)
  let n = 0
  for (const w of want) if (have.has(w)) n++
  return n / want.size
}

const MIN_HIT_SCORE = 0.5

export interface DocsAnswer {
  steps: HowtoStep[]
  sources: HowtoSource[]
}

/**
 * Microsoft Learn: search, keep hits that share at least half the goal's words (the search
 * ranks loosely), read up to two articles and take the first with a numbered list of steps.
 */
export async function learnHowto(
  app: string,
  goal: string,
  get: GetText,
  signal?: AbortSignal
): Promise<DocsAnswer | null> {
  const res = await get(learnSearchUrl(`${app} ${goal}`), 'application/json', signal)
  if (res.status !== 200) return null
  const hits = parseLearn(res.body)
    .map((h) => ({ h, s: hitScore(h, goal) }))
    .filter((x) => x.s >= MIN_HIT_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, ARTICLES_TRIED)
  for (const { h } of hits) {
    signal?.throwIfAborted()
    const page = await get(h.url, 'text/html,application/xhtml+xml', signal).catch(() => null)
    if (!page || page.status !== 200) continue
    const steps = stepsFromHtml(page.body)
    if (steps.length >= 2) return { steps, sources: [{ title: h.title, url: page.url }] }
  }
  return null
}
