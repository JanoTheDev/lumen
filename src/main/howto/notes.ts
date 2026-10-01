// Learned per-app notes (05 T36): what worked last time in an app, so the next task skips the
// lookup. `~/.ai-overlay/app-notes/<appId>.json`: app + version → goal → working path (element
// names, automation ids, menu path, shortcut). Local only, redacted, size-capped; notes from an
// older major version are dropped when the app updates; a note whose path fails twice is
// removed. Separate from the per-app memory facts (ai/memory AppLayer): those are the user's
// own preferences in markdown, these are machine paths with counters. No Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isSensitive } from '../ai/memory/sensitive'
import { isContentName, noteGoal } from './goal'
import { majorOf } from './version'
import type { AppIdentity } from './types'

export const MAX_NOTES = 40
export const MAX_FILE_BYTES = 24 * 1024
export const FAILS_TO_DROP = 2
const MAX_GOAL = 120
const MAX_NAME = 48
const MAX_PATH = 8
const MATCH_MIN = 0.6

export interface AppNotePath {
  /** UI names in the order they were used (menu path segments, buttons, fields). */
  ui: string[]
  automationIds?: string[]
  shortcut?: string
}

export interface AppNote {
  goal: string
  path: AppNotePath
  /** App version the path worked in ('' unknown). */
  version: string
  source: 'learned' | 'lookup'
  /** Last success (ms). */
  at: number
  uses: number
  fails: number
}

interface NotesFile {
  version: 1
  app: string
  appVersion: string
  notes: AppNote[]
}

const STOP = new Set(
  'a an the to in on of for and or my me i how do does can you please with from into this that it is be'.split(
    ' '
  )
)

/** Content words of a goal, for matching ("Change the default font" → change, default, font). */
export function goalWords(goal: string): Set<string> {
  return new Set(
    goal
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w))
  )
}

/** 0..1 overlap of two goals (Jaccard on content words). */
export function goalMatch(a: string, b: string): number {
  const x = goalWords(a)
  const y = goalWords(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

function safeName(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t || t.length > MAX_NAME || isSensitive(t) || isContentName(t)) return null
  return t
}

/** A path with secrets and long (content, not UI) names left out; null when nothing is left. */
export function cleanPath(p: AppNotePath): AppNotePath | null {
  const ui = p.ui
    .map(safeName)
    .filter((x): x is string => !!x)
    .slice(0, MAX_PATH)
  const ids = (p.automationIds ?? [])
    .map(safeName)
    .filter((x): x is string => !!x)
    .slice(0, MAX_PATH)
  const shortcut = p.shortcut && p.shortcut.length <= 40 ? p.shortcut : undefined
  if (!ui.length && !ids.length && !shortcut) return null
  return { ui, ...(ids.length ? { automationIds: ids } : {}), ...(shortcut ? { shortcut } : {}) }
}

export class AppNotesStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  private file(appId: string): string {
    return join(this.dir, `${appId.replace(/[^a-z0-9-]/g, '-').slice(0, 60) || 'unknown'}.json`)
  }

  read(appId: string): NotesFile | null {
    try {
      const path = this.file(appId)
      if (!existsSync(path)) return null
      const f = JSON.parse(readFileSync(path, 'utf8')) as NotesFile
      return f && f.version === 1 && Array.isArray(f.notes) ? f : null
    } catch {
      return null
    }
  }

  private write(appId: string, f: NotesFile): void {
    const path = this.file(appId)
    if (!f.notes.length) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    // Newest first; drop the oldest until the file fits.
    f.notes.sort((a, b) => b.at - a.at)
    f.notes = f.notes.slice(0, MAX_NOTES)
    let json = JSON.stringify(f, null, 1)
    while (Buffer.byteLength(json) > MAX_FILE_BYTES && f.notes.length > 1) {
      f.notes.pop()
      json = JSON.stringify(f, null, 1)
    }
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, path)
  }

  /** The file for this app, with notes of another major version pruned (app updated). */
  private load(id: AppIdentity): NotesFile {
    const f = this.read(id.appId) ?? { version: 1, app: id.app, appVersion: id.version, notes: [] }
    if (id.version && f.appVersion !== id.version) {
      const major = majorOf(id.version)
      const before = f.notes.length
      f.notes = f.notes.filter((n) => !n.version || majorOf(n.version) === major)
      f.appVersion = id.version
      if (f.notes.length !== before) this.write(id.appId, f)
    }
    return f
  }

  /** The best note for a goal in this app version, or null. */
  find(id: AppIdentity, goal: string): AppNote | null {
    const f = this.load(id)
    let best: AppNote | null = null
    let score = 0
    for (const n of f.notes) {
      const s = goalMatch(n.goal, goal)
      if (s >= MATCH_MIN && s > score) {
        best = n
        score = s
      }
    }
    return best
  }

  list(appId: string): AppNote[] {
    return this.read(appId)?.notes ?? []
  }

  /** Keeps (or refreshes) a working path for a goal. False when nothing safe was left to keep. */
  recordSuccess(
    id: AppIdentity,
    goal: string,
    path: AppNotePath,
    source: AppNote['source'] = 'learned'
  ): boolean {
    // The task, never its content: no recipients, quoted text or what to write.
    const g = noteGoal(goal)?.slice(0, MAX_GOAL)
    const p = cleanPath(path)
    if (!g || !p) return false
    const f = this.load(id)
    const same = f.notes.find((n) => goalMatch(n.goal, g) >= 0.9)
    const at = this.now()
    if (same)
      Object.assign(same, { path: p, version: id.version, at, uses: same.uses + 1, fails: 0 })
    else f.notes.push({ goal: g, path: p, version: id.version, source, at, uses: 1, fails: 0 })
    this.write(id.appId, f)
    return true
  }

  /** One more failure of a note's path; at FAILS_TO_DROP the note is removed. True = removed. */
  recordFailure(id: AppIdentity, goal: string): boolean {
    const f = this.load(id)
    const n = f.notes.find((x) => goalMatch(x.goal, goal) >= 0.9)
    if (!n) return false
    n.fails += 1
    const drop = n.fails >= FAILS_TO_DROP
    if (drop) f.notes = f.notes.filter((x) => x !== n)
    this.write(id.appId, f)
    return drop
  }

  forget(appId: string): void {
    const path = this.file(appId)
    if (existsSync(path)) unlinkSync(path)
  }
}
