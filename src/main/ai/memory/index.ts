/**
 * Local memory for Lumen. `createMemory({ dir?, settings?, now? })` returns a `Memory` with layers
 * `profile`, `apps`, `working`, `session`, `episodes`; `remember()` writes a fact now, `endSession(summarize)`
 * turns the session into an episode + fact proposals (auto-applied or queued per `memory.autoLearn`),
 * and `buildMemoryContext(query, app, cap)` returns the capped block for the user turn.
 * Nothing is written when memory is off or in private mode (the session then stays in RAM only).
 */
import { DEFAULT_CONFIG_V2, type ConfigV2 } from '@shared/config'
import { EpisodeStore, type Episode, type EpisodeDraft } from './episodes'
import { AppLayer, ProfileLayer, type AddFactInput } from './profile'
import {
  assembleContext,
  createEpisodeIndex,
  DEFAULT_CAP_TOKENS,
  rankEpisodes,
  type EpisodeIndex,
  type IndexBackend,
  type RankedEpisode
} from './retrieve'
import { isSensitive } from './sensitive'
import { DEFAULT_MEMORY_DIR, MemoryStore, type UpsertResult } from './store'
import { SessionLayer, WorkingLayer } from './working'

export type MemorySettings = ConfigV2['memory']
export type MemoryLayer = 'profile' | 'app' | 'working'

export interface FactProposal {
  layer: MemoryLayer
  appId?: string
  fact: string
  confidence: number
  sensitive: boolean
  /** Profile section, when the model knows it. */
  section?: string
  /** Text of an older fact this one contradicts. */
  replaces?: string
}

export interface SessionSummary {
  episode: EpisodeDraft
  facts: FactProposal[]
}

/** Fast-model call supplied by the provider layer; gets the redacted transcript. */
export type Summarizer = (transcript: string) => Promise<SessionSummary>

export interface PendingProposal extends FactProposal {
  id: string
  createdAt: string
}

export interface SessionEndResult {
  status: 'empty' | 'private' | 'disabled' | 'saved'
  episode?: Episode
  applied: FactProposal[]
  queued: PendingProposal[]
  dropped: FactProposal[]
}

export interface MemoryOptions {
  dir?: string
  settings?: () => MemorySettings
  now?: () => Date
  index?: 'auto' | IndexBackend
  log?: (message: string) => void
}

export const AUTO_APPLY_CONFIDENCE = 0.8
const PENDING_FILE = 'pending.json'

export class Memory {
  readonly store: MemoryStore
  readonly profile: ProfileLayer
  readonly apps: AppLayer
  readonly working: WorkingLayer
  readonly session: SessionLayer
  readonly episodes: EpisodeStore
  private readonly settings: () => MemorySettings
  private index: EpisodeIndex | null = null
  private byId = new Map<string, Episode>()

  constructor(private readonly opts: MemoryOptions = {}) {
    this.store = new MemoryStore(opts.dir ?? DEFAULT_MEMORY_DIR, opts.now)
    this.settings = opts.settings ?? (() => DEFAULT_CONFIG_V2.memory)
    this.profile = new ProfileLayer(this.store)
    this.apps = new AppLayer(this.store)
    this.working = new WorkingLayer(this.store)
    this.session = new SessionLayer(this.store, () => !this.settings().privateMode)
    this.episodes = new EpisodeStore(this.store)
  }

  /** Long-term writes happen only with memory on and private mode off. */
  canWrite(): boolean {
    const s = this.settings()
    return s.enabled && !s.privateMode
  }

  get backend(): IndexBackend {
    return this.getIndex().backend
  }

  private getIndex(): EpisodeIndex {
    if (this.index) return this.index
    this.index = createEpisodeIndex(this.opts.index)
    ;(this.opts.log ?? console.info)(`[memory] episode index: ${this.index.backend}`)
    for (const e of this.episodes.list()) this.indexEpisode(e)
    return this.index
  }

  private indexEpisode(e: Episode): void {
    this.byId.set(e.id, e)
    this.index?.upsert(e)
  }

  private unindex(id: string): void {
    this.byId.delete(id)
    this.index?.remove(id)
  }

  /** Explicit "remember that …": written immediately. Returns 'disabled' when writes are off. */
  remember(
    fact: string,
    opts: { layer?: MemoryLayer; app?: string } & Omit<AddFactInput, 'text' | 'source'> = {}
  ): UpsertResult | 'disabled' {
    if (!this.canWrite()) return 'disabled'
    return this.writeFact(opts.layer ?? 'profile', fact, 'said', opts)
  }

  private writeFact(
    layer: MemoryLayer,
    text: string,
    source: 'said' | 'inferred',
    opts: { app?: string; section?: string; replaces?: string }
  ): UpsertResult {
    if (layer === 'working') return this.working.add(text, opts.replaces)
    if (layer === 'app') {
      if (!opts.app) return 'rejected'
      return this.apps.add(opts.app, { text, source, replaces: opts.replaces })
    }
    return this.profile.add({ text, source, section: opts.section, replaces: opts.replaces })
  }

  /** Forget facts containing `match` (case-insensitive) across profile, app and working files. */
  forget(match: string): number {
    const needle = match.trim().toLowerCase()
    if (!needle) return 0
    const pred = (f: { text: string }): boolean => f.text.toLowerCase().includes(needle)
    let n = this.profile.file.remove(pred).length + this.working.file.remove(pred).length
    for (const id of this.apps.ids()) n += this.apps.remove(id, pred).length
    return n
  }

  /**
   * Session end: summarize the redacted transcript once, save the episode, then apply or queue
   * the non-sensitive fact proposals. Private mode / memory off: the session is dropped unsummarized.
   */
  async endSession(summarize: Summarizer): Promise<SessionEndResult> {
    const result: SessionEndResult = { status: 'empty', applied: [], queued: [], dropped: [] }
    const turns = this.session.turns()
    if (!turns.length) return result
    const s = this.settings()
    if (s.privateMode || !s.enabled) {
      this.session.clear()
      return { ...result, status: s.privateMode ? 'private' : 'disabled' }
    }
    const summary = await summarize(this.session.transcript())
    this.session.drop(turns.length)
    if (!this.canWrite()) return { ...result, status: 'private' }

    const episode = this.episodes.save(summary.episode)
    if (this.index) this.indexEpisode(episode)
    result.status = 'saved'
    result.episode = episode

    const fallbackApp = episode.apps[0]
    const queue: PendingProposal[] = []
    for (const p of summary.facts ?? []) {
      const proposal = { ...p, appId: p.appId ?? (p.layer === 'app' ? fallbackApp : undefined) }
      if (p.sensitive || isSensitive(p.fact) || (p.layer === 'app' && !proposal.appId)) {
        result.dropped.push(proposal)
      } else if (s.autoLearn === 'auto' && p.confidence >= AUTO_APPLY_CONFIDENCE) {
        const r = this.writeFact(p.layer, p.fact, 'inferred', { ...proposal, app: proposal.appId })
        if (r === 'rejected') result.dropped.push(proposal)
        else result.applied.push(proposal)
      } else if (s.autoLearn !== 'off') {
        queue.push({
          ...proposal,
          id: `${episode.id}-${queue.length}`,
          createdAt: episode.date
        })
      }
    }
    if (queue.length) {
      this.savePending([...this.pending(), ...queue])
      result.queued = queue
    }
    this.episodes.prune(s.retentionDays).forEach((id) => this.unindex(id))
    return result
  }

  /** Proposals waiting for the user's review. */
  pending(): PendingProposal[] {
    try {
      const raw = JSON.parse(this.store.read(PENDING_FILE) ?? '[]')
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private savePending(list: PendingProposal[]): void {
    if (!list.length) this.store.remove(PENDING_FILE)
    else this.store.write(PENDING_FILE, JSON.stringify(list, null, 2))
  }

  acceptPending(id: string): UpsertResult | 'disabled' | null {
    const list = this.pending()
    const p = list.find((x) => x.id === id)
    if (!p) return null
    if (!this.canWrite()) return 'disabled'
    this.savePending(list.filter((x) => x !== p))
    return this.writeFact(p.layer, p.fact, 'inferred', { ...p, app: p.appId })
  }

  rejectPending(id: string): boolean {
    const list = this.pending()
    const next = list.filter((x) => x.id !== id)
    if (next.length === list.length) return false
    this.savePending(next)
    return true
  }

  deleteEpisode(id: string): boolean {
    const ok = this.episodes.remove(id)
    if (ok) this.unindex(id)
    return ok
  }

  searchEpisodes(query: string, app?: string, limit = 3): RankedEpisode[] {
    const index = this.getIndex()
    return rankEpisodes(index, (id) => this.byId.get(id), query, {
      app,
      now: this.store.now(),
      limit
    })
  }

  /** The memory block for the user turn ('' when memory is off or empty). */
  buildMemoryContext(query: string, app?: string, capTokens?: number): string {
    const s = this.settings()
    if (!s.enabled) return ''
    const cap = capTokens ?? s.maxInjectTokens ?? DEFAULT_CAP_TOKENS
    return assembleContext(
      {
        profile: this.profile.facts(),
        app: app ? { name: app, facts: this.apps.facts(app) } : undefined,
        working: this.working.facts(),
        episodes: this.searchEpisodes(query, app, 3).map((r) => r.episode)
      },
      cap
    )
  }
}

export function createMemory(opts: MemoryOptions = {}): Memory {
  return new Memory(opts)
}

export type { Episode, EpisodeDraft, EpisodeOutcome, EpisodeRef } from './episodes'
export type { Fact, FactSource, UpsertResult } from './store'
export type { SessionTurn } from './working'
export type { IndexBackend, RankedEpisode } from './retrieve'
export { PROFILE_SECTIONS, appIdOf } from './profile'
export { findSensitive, isSensitive, redact } from './sensitive'
export { assembleContext, estimateTokens } from './retrieve'
