// Episode search (FTS5 via node:sqlite when the runtime has it, else an in-process BM25) and the
// capped, priority-ordered memory block injected into the user turn.
import type { Episode } from './episodes'
import type { Fact } from './store'

export type IndexBackend = 'sqlite-fts5' | 'json-bm25'

export interface EpisodeIndex {
  readonly backend: IndexBackend
  upsert(e: Episode): void
  remove(id: string): void
  /** Raw relevance per matching episode id (higher is better). */
  search(query: string, limit: number): { id: string; score: number }[]
}

const STOPWORDS = new Set(
  'a an and are as at be but by can did do does for from how i in is it me my of on or so that the this to was we what when where which who why with you your yesterday today last time about'.split(
    ' '
  )
)

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  )
}

const docText = (e: Episode): string =>
  [
    e.title,
    e.title,
    e.summary,
    e.apps.join(' '),
    e.openThreads.join(' '),
    e.refs.map((r) => r.value).join(' ')
  ].join(' ')

/** Small Okapi BM25 over episodes kept in memory (rebuilt from the markdown files on start). */
export class Bm25Index implements EpisodeIndex {
  readonly backend = 'json-bm25' as const
  private docs = new Map<string, Map<string, number>>()
  private lengths = new Map<string, number>()

  upsert(e: Episode): void {
    const tf = new Map<string, number>()
    const toks = tokenize(docText(e))
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.set(e.id, tf)
    this.lengths.set(e.id, toks.length)
  }

  remove(id: string): void {
    this.docs.delete(id)
    this.lengths.delete(id)
  }

  search(query: string, limit: number): { id: string; score: number }[] {
    const q = [...new Set(tokenize(query))]
    const n = this.docs.size
    if (!q.length || !n) return []
    const k1 = 1.2
    const b = 0.75
    const avg = [...this.lengths.values()].reduce((s, l) => s + l, 0) / n || 1
    const out: { id: string; score: number }[] = []
    for (const [id, tf] of this.docs) {
      let score = 0
      for (const t of q) {
        const f = tf.get(t)
        if (!f) continue
        let df = 0
        for (const d of this.docs.values()) if (d.has(t)) df++
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * (this.lengths.get(id) ?? 0)) / avg))
      }
      if (score > 0) out.push({ id, score })
    }
    return out.sort((a, b2) => b2.score - a.score).slice(0, limit)
  }
}

type SqliteModule = typeof import('node:sqlite')
type Db = InstanceType<SqliteModule['DatabaseSync']>

function loadSqlite(): SqliteModule | null {
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
    return mod?.DatabaseSync ? mod : null
  } catch {
    return null
  }
}

/** In-memory SQLite FTS5 table; bm25() is negated so higher is better. */
export class SqliteFtsIndex implements EpisodeIndex {
  readonly backend = 'sqlite-fts5' as const

  private constructor(private readonly db: Db) {}

  static tryCreate(): SqliteFtsIndex | null {
    const mod = loadSqlite()
    if (!mod) return null
    try {
      const db = new mod.DatabaseSync(':memory:')
      db.exec(
        'CREATE VIRTUAL TABLE ep USING fts5(id UNINDEXED, title, summary, apps, threads, refs)'
      )
      return new SqliteFtsIndex(db)
    } catch {
      return null
    }
  }

  upsert(e: Episode): void {
    this.remove(e.id)
    this.db
      .prepare('INSERT INTO ep (id, title, summary, apps, threads, refs) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        e.id,
        e.title,
        e.summary,
        e.apps.join(' '),
        e.openThreads.join(' '),
        e.refs.map((r) => r.value).join(' ')
      )
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM ep WHERE id = ?').run(id)
  }

  search(query: string, limit: number): { id: string; score: number }[] {
    const q = [...new Set(tokenize(query))]
    if (!q.length) return []
    const match = q.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const rows = this.db
      .prepare(
        'SELECT id, -bm25(ep, 0, 2.0, 1.0, 1.0, 1.0, 1.0) AS score FROM ep WHERE ep MATCH ? ORDER BY score DESC LIMIT ?'
      )
      .all(match, limit) as { id: string; score: number }[]
    return rows.map((r) => ({ id: String(r.id), score: Number(r.score) }))
  }
}

/** Picks FTS5 when `node:sqlite` exists and was built with FTS5, otherwise BM25 in JS. */
export function createEpisodeIndex(prefer: 'auto' | IndexBackend = 'auto'): EpisodeIndex {
  if (prefer !== 'json-bm25') {
    const fts = SqliteFtsIndex.tryCreate()
    if (fts) return fts
  }
  return new Bm25Index()
}

// ---- ranking ----

export const RECENCY_HALF_LIFE_DAYS = 30
export const SAME_APP_BOOST = 2
export const OPEN_THREADS_BOOST = 1.5
/** Floor on the recency factor so a strong old match can still surface. */
export const RECENCY_FLOOR = 0.05

export interface RankedEpisode {
  episode: Episode
  score: number
}

export function rankEpisodes(
  index: EpisodeIndex,
  byId: (id: string) => Episode | undefined,
  query: string,
  opts: { app?: string; now: Date; limit?: number }
): RankedEpisode[] {
  const app = opts.app?.toLowerCase()
  const hits = index.search(query, 50)
  const max = Math.max(...hits.map((h) => h.score), 0) || 1
  const ranked: RankedEpisode[] = []
  for (const h of hits) {
    const e = byId(h.id)
    if (!e) continue
    const ageDays = Math.max(0, (opts.now.getTime() - Date.parse(e.date)) / 86_400_000)
    const recency = Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS))
    const sameApp = app && e.apps.some((a) => a.toLowerCase() === app) ? SAME_APP_BOOST : 1
    const threads = e.openThreads.length ? OPEN_THREADS_BOOST : 1
    ranked.push({ episode: e, score: (h.score / max) * recency * sameApp * threads })
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 3)
}

// ---- context block ----

export const DEFAULT_CAP_TOKENS = 1200

/** Rough token estimate (≈4 chars per token), good enough for a budget. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4)

export interface ContextParts {
  profile: Fact[]
  app?: { name: string; facts: Fact[] }
  working: Fact[]
  episodes: Episode[]
}

export function episodeLine(e: Episode): string {
  const apps = e.apps.length ? ` · ${e.apps.join(', ')}` : ''
  const threads = e.openThreads.length ? ` Open: ${e.openThreads.join('; ')}.` : ''
  return `- ${e.date.slice(0, 10)}${apps} · ${e.title} (${e.outcome}): ${e.summary}${threads}`
}

/**
 * Builds the memory block in strict priority order: profile (already sorted by section priority),
 * foreground-app facts, working memory, episodes. The first line that would exceed the cap stops
 * the fill, so everything of lower priority is dropped. Returns '' when nothing fits or exists.
 */
export function assembleContext(parts: ContextParts, capTokens = DEFAULT_CAP_TOKENS): string {
  const groups: [string, string[]][] = [
    ['About the user:', parts.profile.map((f) => `- ${f.text}`)],
    [
      `Notes for ${parts.app?.name ?? 'this app'}:`,
      (parts.app?.facts ?? []).map((f) => `- ${f.text}`)
    ],
    ['Currently working on:', parts.working.map((f) => `- ${f.text}`)],
    ['Related past sessions:', parts.episodes.map(episodeLine)]
  ]
  const open = '<memory>'
  const close = '</memory>'
  const cost = (s: string): number => estimateTokens(`${s}\n`)
  let used = cost(open) + cost(close)
  const body: string[] = []
  outer: for (const [header, lines] of groups) {
    if (!lines.length) continue
    const headerCost = cost(header)
    let headerAdded = false
    for (const line of lines) {
      const lineCost = cost(line) + (headerAdded ? 0 : headerCost)
      if (used + lineCost > capTokens) break outer
      if (!headerAdded) body.push(header)
      headerAdded = true
      body.push(line)
      used += lineCost
    }
  }
  return body.length ? [open, ...body, close].join('\n') : ''
}
