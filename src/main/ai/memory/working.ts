// Working memory (VOLATILE.md, 14-day expiry) and the session layer (RAM + sessions/current.jsonl).
import { FactFile, isoDay, type Fact, type MemoryStore, type UpsertResult } from './store'
import { redact } from './sensitive'

export const WORKING_TTL_DAYS = 14
export const SESSION_IDLE_MS = 30 * 60_000
const DAY_MS = 86_400_000

export class WorkingLayer {
  readonly file: FactFile

  constructor(private readonly store: MemoryStore) {
    this.file = new FactFile(store, 'VOLATILE.md', 'Working on', ['Current'])
  }

  private fresh(f: Fact): boolean {
    if (!f.date) return true
    return this.store.now().getTime() - Date.parse(f.date) < WORKING_TTL_DAYS * DAY_MS
  }

  /** Unexpired facts. Re-adding a fact refreshes its date. */
  facts(): Fact[] {
    return this.file.read().filter((f) => this.fresh(f))
  }

  add(text: string, replaces?: string): UpsertResult {
    this.prune()
    return this.file.upsert({ section: 'Current', text, source: 'inferred', replaces })
  }

  prune(): number {
    return this.file.remove((f) => !this.fresh(f)).length
  }
}

export interface SessionTurn {
  /** epoch ms */
  ts: number
  utterance: string
  answer?: string
  mode?: string
  app?: string
  targets?: string[]
}

const SESSION_FILE = 'sessions/current.jsonl'

/**
 * The current conversation. Always on (follow-ups need it); persisted so it survives a restart,
 * except in private mode where it stays in RAM only. Text is redacted before it is kept.
 */
export class SessionLayer {
  private items: SessionTurn[] | null = null

  constructor(
    private readonly store: MemoryStore,
    private readonly persist: () => boolean
  ) {}

  private load(): SessionTurn[] {
    if (this.items) return this.items
    const raw = this.store.read(SESSION_FILE) ?? ''
    this.items = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const t = JSON.parse(line) as SessionTurn
        if (typeof t.ts === 'number' && typeof t.utterance === 'string') this.items.push(t)
      } catch {
        // skip a torn last line
      }
    }
    return this.items
  }

  turns(): SessionTurn[] {
    return this.load().map((t) => ({ ...t }))
  }

  lastActivity(): number | null {
    const t = this.load()
    return t.length ? t[t.length - 1].ts : null
  }

  /** True when the last turn is older than the 30 min idle limit (e.g. found after a restart). */
  isStale(): boolean {
    const last = this.lastActivity()
    return last !== null && this.store.now().getTime() - last > SESSION_IDLE_MS
  }

  add(turn: Omit<SessionTurn, 'ts'> & { ts?: number; sensitive?: boolean }): SessionTurn {
    const { sensitive, ...rest } = turn
    const clean: SessionTurn = {
      ...rest,
      ts: turn.ts ?? this.store.now().getTime(),
      utterance: sensitive ? '[redacted:password]' : redact(turn.utterance),
      ...(turn.answer !== undefined && {
        answer: sensitive ? '[redacted:password]' : redact(turn.answer)
      })
    }
    this.load().push(clean)
    if (this.persist()) this.store.append(SESSION_FILE, JSON.stringify(clean) + '\n')
    return clean
  }

  /** Drops the oldest `n` turns (those already summarized), keeping any added since. */
  drop(n: number): void {
    const rest = this.load().slice(n)
    this.items = rest
    if (!rest.length) this.clear()
    else if (this.persist())
      this.store.write(SESSION_FILE, rest.map((t) => `${JSON.stringify(t)}\n`).join(''))
  }

  clear(): void {
    this.items = []
    if (this.store.exists(SESSION_FILE)) this.store.remove(SESSION_FILE)
  }

  /** Plain-text transcript for the session-end summarizer. */
  transcript(): string {
    return this.load()
      .map((t) => {
        const when = `${isoDay(new Date(t.ts))} ${new Date(t.ts).toISOString().slice(11, 16)}`
        const head = `[${when}${t.app ? ` · ${t.app}` : ''}${t.mode ? ` · ${t.mode}` : ''}]`
        return `${head}\nUser: ${t.utterance}${t.answer ? `\nLumen: ${t.answer}` : ''}`
      })
      .join('\n\n')
  }
}
