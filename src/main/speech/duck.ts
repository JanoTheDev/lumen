// Media ducking while dictating (04 T47, opt-in `dictation.duckMedia`): the master volume of
// the default playback device is lowered when a dictation starts and put back when it ends.
//
// Every exit path restores it: the recording stopping, a cancel, the transcript arriving, the
// bar closing (errors), an 11 minute safety timer, quitting, and a crash (the original level is written to
// ~/.ai-overlay/duck.json before lowering; the next start puts it back). The volume is only
// put back while it still sits where Lumen left it, so a change the user made meanwhile wins.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AgentBridge } from '../agent/bridge'
import { audioOutput, audioSetVolume } from '../agent/commands'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'

/** Ducked level = this share of the current volume. */
export const DUCK_FACTOR = 0.3
/** Below this the volume is left alone (nothing to duck). */
export const MIN_DUCK_VOLUME = 0.08
/** Two volumes this close count as the same (the device rounds). */
const SAME = 0.02
/** Longest dictation (10 min) plus margin. */
export const DUCK_MAX_MS = 11 * 60_000

export interface DuckState {
  original: number
  ducked: number
}

export interface DuckIo {
  read(): Promise<{ muted: boolean; volume: number }>
  set(level: number): Promise<void>
}

export interface DuckStore {
  load(): DuckState | null
  save(s: DuckState): void
  clear(): void
}

/** Serialised duck / restore: a restore asked while ducking runs right after it. */
export class Ducker {
  private state: DuckState | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly io: DuckIo,
    private readonly store: DuckStore
  ) {}

  get ducked(): boolean {
    return this.state !== null
  }

  duck(): Promise<void> {
    return this.queue(async () => {
      if (this.state) return
      const now = await this.io.read()
      if (now.muted || now.volume < MIN_DUCK_VOLUME) return
      const ducked = Math.round(now.volume * DUCK_FACTOR * 100) / 100
      const state = { original: now.volume, ducked }
      // Written first: if Lumen dies while ducked, the next start restores.
      this.store.save(state)
      this.state = state
      await this.io.set(ducked)
    })
  }

  restore(): Promise<void> {
    return this.queue(async () => {
      const state = this.state ?? this.store.load()
      if (!state) return
      this.state = null
      try {
        const now = await this.io.read()
        if (Math.abs(now.volume - state.ducked) <= SAME) await this.io.set(state.original)
        else log('skip', 'media ducking: volume changed meanwhile, left as it is')
        this.store.clear()
      } catch (e) {
        // Agent gone: keep the file, the next restore (or start) tries again.
        this.state = state
        throw e
      }
    })
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {})
    return run
  }
}

const FILE = join(homedir(), '.ai-overlay', 'duck.json')

export const fileStore: DuckStore = {
  load() {
    try {
      if (!existsSync(FILE)) return null
      const s = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<DuckState>
      const ok = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
      return ok(s.original) && ok(s.ducked) ? { original: s.original, ducked: s.ducked } : null
    } catch {
      return null
    }
  },
  save(s) {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(s), 'utf8')
  },
  clear() {
    rmSync(FILE, { force: true })
  }
}

let ducker: Ducker | null = null
let safety: ReturnType<typeof setTimeout> | null = null

/** Puts the volume back if this dictation lowered it. Safe to call any time. */
export function restoreMedia(): void {
  if (safety) clearTimeout(safety)
  safety = null
  ducker?.restore().catch((e: Error) => log('fail', `media ducking restore failed: ${e.message}`))
}

/** Wires ducking to the dictation lifecycle; a leftover from a crash is restored now. */
export function installMediaDucking(agent: AgentBridge): void {
  const usable = (): boolean => agent.running && agent.hasCapability('audio-volume')
  ducker = new Ducker(
    {
      read: () => audioOutput(agent, { timeoutMs: 2000 }),
      set: async (level) => {
        await audioSetVolume(agent, level, { timeoutMs: 2000 })
      }
    },
    fileStore
  )
  const leftover = (): void => {
    if (usable() && fileStore.load()) restoreMedia()
  }
  agent.onEvent('agent-ready', leftover)
  leftover()
  bus.on('dictation.started', () => {
    if (!loadConfig().dictation.duckMedia || !usable()) return
    ducker
      ?.duck()
      .then(() => {
        if (safety) clearTimeout(safety)
        safety = setTimeout(restoreMedia, DUCK_MAX_MS)
      })
      .catch((e: Error) => log('fail', `media ducking failed: ${e.message}`))
  })
  // The duck may still be starting when the key is released: restore queues behind it.
  for (const type of ['voice.stopped', 'voice.cancelled', 'query.started'] as const)
    bus.on(type, restoreMedia)
  app.on('will-quit', restoreMedia)
}
