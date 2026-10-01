// File layer: memory root, atomic writes, and one-fact-per-line markdown files with a history sibling.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { isSensitive } from './sensitive'

export const DEFAULT_MEMORY_DIR = join(homedir(), '.ai-overlay', 'memory')

export type FactSource = 'said' | 'inferred'

export interface Fact {
  section: string
  text: string
  /** YYYY-MM-DD; undefined for hand-written lines without the metadata comment. */
  date?: string
  source: FactSource
}

export type UpsertResult = 'added' | 'refreshed' | 'replaced' | 'rejected'

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

export class MemoryStore {
  constructor(
    readonly dir: string = DEFAULT_MEMORY_DIR,
    readonly now: () => Date = () => new Date()
  ) {}

  path(rel: string): string {
    return join(this.dir, rel)
  }

  exists(rel: string): boolean {
    return existsSync(this.path(rel))
  }

  read(rel: string): string | null {
    try {
      return readFileSync(this.path(rel), 'utf8')
    } catch {
      return null
    }
  }

  /** Write via temp file + rename so a crash never leaves a half-written file. */
  write(rel: string, content: string): void {
    const full = this.path(rel)
    mkdirSync(dirname(full), { recursive: true })
    const tmp = `${full}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, full)
  }

  append(rel: string, content: string): void {
    const full = this.path(rel)
    mkdirSync(dirname(full), { recursive: true })
    appendFileSync(full, content, 'utf8')
  }

  remove(rel: string): void {
    rmSync(this.path(rel), { force: true })
  }

  list(rel: string): string[] {
    try {
      return readdirSync(this.path(rel))
    } catch {
      return []
    }
  }
}

const FACT_LINE = /^[-*]\s+(.*?)\s*(?:<!--\s*(\d{4}-\d{2}-\d{2})\s*·\s*(said|inferred)\s*-->)?\s*$/

export const normFact = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Subject of a "X is Y" / "X: Y" fact, used to spot contradictions. */
export function factKey(text: string): string | null {
  const m =
    /^(.{2,60}?)\s+(?:is|are|am|was|=|uses|prefers)\s+\S/i.exec(text) ??
    /^([^:]{2,60}):\s*\S/.exec(text)
  return m ? normFact(m[1]) : null
}

/**
 * A markdown file of `## Section` headings with one bullet fact per line:
 * `- Prefers short answers <!-- 2026-10-01 · said -->`. Only headings and bullets are kept on rewrite.
 * Replaced facts are appended to `<name>.history.md`.
 */
export class FactFile {
  constructor(
    private readonly store: MemoryStore,
    readonly rel: string,
    private readonly title: string,
    private readonly sectionOrder: readonly string[] = []
  ) {}

  get historyRel(): string {
    return this.rel.replace(/\.md$/, '.history.md')
  }

  read(): Fact[] {
    const raw = this.store.read(this.rel)
    if (!raw) return []
    const facts: Fact[] = []
    let section = this.sectionOrder[this.sectionOrder.length - 1] ?? 'Notes'
    for (const line of raw.split(/\r?\n/)) {
      const heading = /^##\s+(.+?)\s*$/.exec(line)
      if (heading) {
        section = heading[1]
        continue
      }
      const m = FACT_LINE.exec(line)
      if (m && m[1])
        facts.push({ section, text: m[1], date: m[2], source: (m[3] as FactSource) ?? 'said' })
    }
    return facts
  }

  write(facts: Fact[]): void {
    const sections = new Map<string, Fact[]>()
    for (const s of this.sectionOrder) sections.set(s, [])
    for (const f of facts) sections.set(f.section, [...(sections.get(f.section) ?? []), f])
    let out = `# ${this.title}\n`
    for (const [name, list] of sections) {
      if (!list.length) continue
      out += `\n## ${name}\n`
      for (const f of list)
        out += `- ${f.text}${f.date ? ` <!-- ${f.date} · ${f.source} -->` : ''}\n`
    }
    this.store.write(this.rel, out)
  }

  /**
   * Adds a fact. An identical fact only refreshes its date; a fact with the same subject
   * (or matching `replaces`) replaces the old line, which moves to the history file.
   */
  upsert(input: {
    section: string
    text: string
    source?: FactSource
    replaces?: string
  }): UpsertResult {
    const text = input.text
      .replace(/\s+/g, ' ')
      .replace(/<!--|-->/g, '')
      .trim()
    if (!text || isSensitive(text)) return 'rejected'
    const date = isoDay(this.store.now())
    const fact: Fact = { section: input.section, text, date, source: input.source ?? 'said' }
    const facts = this.read()
    const norm = normFact(text)
    const same = facts.findIndex((f) => normFact(f.text) === norm)
    if (same >= 0) {
      facts[same] = {
        ...facts[same],
        date,
        source: fact.source === 'said' ? 'said' : facts[same].source
      }
      this.write(facts)
      return 'refreshed'
    }
    const key = factKey(text)
    const replacesNorm = input.replaces ? normFact(input.replaces) : null
    const replaced = facts.filter(
      (f) =>
        (replacesNorm && normFact(f.text) === replacesNorm) ||
        (key !== null && f.section === fact.section && factKey(f.text) === key)
    )
    const kept = facts.filter((f) => !replaced.includes(f))
    this.write([...kept, fact])
    if (!replaced.length) return 'added'
    this.store.append(
      this.historyRel,
      replaced
        .map(
          (f) =>
            `- ${date} replaced "${f.text}" (${f.date ?? 'undated'}) with "${text}" [${f.section}]\n`
        )
        .join('')
    )
    return 'replaced'
  }

  /** Removes facts matching the predicate; returns them. Forgotten facts are not kept in history. */
  remove(pred: (f: Fact) => boolean): Fact[] {
    const facts = this.read()
    const gone = facts.filter(pred)
    if (gone.length) this.write(facts.filter((f) => !pred(f)))
    return gone
  }
}
