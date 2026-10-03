// Episodic memory: one markdown summary per past session under episodes/YYYY-MM/<id>.md.
import { randomBytes } from 'crypto'
import type { MemoryStore } from './store'
import { redact } from './sensitive'

export type EpisodeOutcome = 'done' | 'partial' | 'failed' | 'info'
export type EpisodeRefKind = 'url' | 'file' | 'lesson' | 'skill'

export interface EpisodeRef {
  kind: EpisodeRefKind
  value: string
}

/** What the summarizer produces for one session. */
export interface EpisodeDraft {
  title: string
  summary: string
  apps: string[]
  outcome: EpisodeOutcome
  openThreads: string[]
  refs: EpisodeRef[]
}

export interface Episode extends EpisodeDraft {
  id: string
  /** ISO timestamp of the session end. */
  date: string
}

const OUTCOMES: EpisodeOutcome[] = ['done', 'partial', 'failed', 'info']
const REF_KINDS: EpisodeRefKind[] = ['url', 'file', 'lesson', 'skill']
const META = /<!--\s*lumen-episode\s+(\{.*\})\s*-->/
const DAY_MS = 86_400_000

const oneLine = (s: string): string =>
  redact(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim()

/** Normalises and redacts a draft; caps the summary at ~120 words. */
export function cleanDraft(d: EpisodeDraft): EpisodeDraft {
  const words = oneLine(d.summary).split(' ')
  return {
    title: oneLine(d.title).slice(0, 120) || 'Session',
    summary: words.slice(0, 120).join(' ') + (words.length > 120 ? '…' : ''),
    apps: [...new Set((d.apps ?? []).map(oneLine).filter(Boolean))],
    outcome: OUTCOMES.includes(d.outcome) ? d.outcome : 'info',
    openThreads: (d.openThreads ?? []).map(oneLine).filter(Boolean),
    refs: (d.refs ?? [])
      .filter((r) => REF_KINDS.includes(r.kind))
      .map((r) => ({ kind: r.kind, value: oneLine(r.value) }))
      .filter((r) => r.value && !r.value.includes('[redacted:'))
  }
}

export function serializeEpisode(e: Episode): string {
  const meta = JSON.stringify({ id: e.id, date: e.date, apps: e.apps, outcome: e.outcome })
  let out = `# ${e.title}\n<!-- lumen-episode ${meta} -->\n\n${e.summary}\n`
  if (e.openThreads.length)
    out += `\n## Open threads\n${e.openThreads.map((t) => `- ${t}\n`).join('')}`
  if (e.refs.length)
    out += `\n## References\n${e.refs.map((r) => `- ${r.kind}: ${r.value}\n`).join('')}`
  return out
}

/** Parses an episode file; hand edits to title, summary, threads and references are honoured. */
export function parseEpisode(raw: string): Episode | null {
  const metaMatch = META.exec(raw)
  if (!metaMatch) return null
  let meta: Partial<Episode>
  try {
    meta = JSON.parse(metaMatch[1])
  } catch {
    return null
  }
  if (typeof meta.id !== 'string' || typeof meta.date !== 'string') return null
  const lines = raw.replace(META, '').split(/\r?\n/)
  let title = 'Session'
  let section = ''
  const summary: string[] = []
  const openThreads: string[] = []
  const refs: EpisodeRef[] = []
  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line)
    const h2 = /^##\s+(.+)$/.exec(line)
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (h1) title = h1[1].trim()
    else if (h2) section = h2[1].trim().toLowerCase()
    else if (section === 'open threads' && bullet) openThreads.push(bullet[1].trim())
    else if (section === 'references' && bullet) {
      const m = /^(url|file|lesson|skill):\s*(.+)$/.exec(bullet[1].trim())
      if (m) refs.push({ kind: m[1] as EpisodeRefKind, value: m[2] })
    } else if (!section && line.trim()) summary.push(line.trim())
  }
  return {
    id: meta.id,
    date: meta.date,
    title,
    summary: summary.join(' '),
    apps: Array.isArray(meta.apps) ? meta.apps.map(String) : [],
    outcome: OUTCOMES.includes(meta.outcome as EpisodeOutcome)
      ? (meta.outcome as EpisodeOutcome)
      : 'info',
    openThreads,
    refs
  }
}

const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/

export class EpisodeStore {
  constructor(private readonly store: MemoryStore) {}

  private rel(id: string): string {
    return `episodes/${id.slice(0, 4)}-${id.slice(4, 6)}/${id}.md`
  }

  newId(at: Date): string {
    const s = at.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    return `${s.slice(0, 8)}-${s.slice(8)}-${randomBytes(2).toString('hex')}`
  }

  save(draft: EpisodeDraft): Episode {
    const at = this.store.now()
    const episode: Episode = { ...cleanDraft(draft), id: this.newId(at), date: at.toISOString() }
    this.store.write(this.rel(episode.id), serializeEpisode(episode))
    return episode
  }

  get(id: string): Episode | null {
    if (!ID_RE.test(id)) return null
    const raw = this.store.read(this.rel(id))
    return raw ? parseEpisode(raw) : null
  }

  /** All episodes, newest first. */
  list(): Episode[] {
    const out: Episode[] = []
    for (const month of this.store.list('episodes')) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue
      for (const file of this.store.list(`episodes/${month}`)) {
        if (!file.endsWith('.md')) continue
        const raw = this.store.read(`episodes/${month}/${file}`)
        const e = raw ? parseEpisode(raw) : null
        if (e) out.push(e)
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date))
  }

  /** Same as `list()`, with the folders and files read asynchronously. */
  async listAsync(): Promise<Episode[]> {
    const out: Episode[] = []
    const months = (await this.store.listAsync('episodes')).filter((m) => /^\d{4}-\d{2}$/.test(m))
    for (const month of months) {
      const files = (await this.store.listAsync(`episodes/${month}`)).filter((f) =>
        f.endsWith('.md')
      )
      const raws = await Promise.all(
        files.map((f) => this.store.readAsync(`episodes/${month}/${f}`))
      )
      for (const raw of raws) {
        const e = raw ? parseEpisode(raw) : null
        if (e) out.push(e)
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date))
  }

  remove(id: string): boolean {
    if (!ID_RE.test(id) || !this.store.exists(this.rel(id))) return false
    this.store.remove(this.rel(id))
    return true
  }

  /** Deletes episodes older than `retentionDays`; returns the removed ids. */
  prune(retentionDays: number): string[] {
    const cutoff = this.store.now().getTime() - retentionDays * DAY_MS
    const old = this.list().filter((e) => Date.parse(e.date) < cutoff)
    for (const e of old) this.remove(e.id)
    return old.map((e) => e.id)
  }
}
