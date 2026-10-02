// Buddy files (08 T50): <root>/<id>/buddy.md (a `---` header of JSON values + the instructions
// as the body) and <root>/<id>/memory.md (the notebook, ≤ 8 KB). Every load is validated and
// clamped; a folder with a `.lumen-pack.json` marker (an imported buddy) stays untrusted
// whatever its header says. Writes go through a temp file + rename. Nothing is written to the
// notebook while memory writes are off (memory off or private mode).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { BUDDY_DEFAULT_PER_RUN_USD, BUDDY_NOTEBOOK_MAX_BYTES, type Buddy } from '@shared/buddies'
import { splitFrontmatter, type YamlValue } from '../skills/frontmatter'
import {
  buddyIdFor,
  buddyNameKey,
  clampBuddy,
  freeBuddyName,
  isBuddyId,
  type ClampContext
} from './clamp'

export const BUDDY_FILE = 'buddy.md'
export const NOTEBOOK_FILE = 'memory.md'
/** Written by an import (08 T51): the buddy stays community-untrusted. */
export const IMPORT_MARKER = '.lumen-pack.json'

export type NotebookWrite = 'ok' | 'disabled' | 'rejected' | 'too-long' | 'missing'

export interface BuddyStoreOptions {
  /** Memory writes allowed (memory on, not private): the notebook is written only then. */
  canWrite?: () => boolean
  /** Text that must not be kept (secrets, health …): refused for the notebook. */
  sensitive?: (text: string) => boolean
  /**
   * Connectors / skills that exist, checked when a buddy is saved (default: any well-formed id).
   * Ones the buddy already had stay, so a connector that is away for a moment is not lost.
   */
  clamp?: () => ClampContext
  now?: () => number
}

const HEADER_KEYS = [
  'name',
  'look',
  'model',
  'permissions',
  'skills',
  'subagents',
  'budget',
  'report',
  'scheduleIds',
  'trust',
  'enabled',
  'createdAt',
  'updatedAt'
] as const

/** buddy.md text: one `key: <JSON>` line per field (JSON is valid flow YAML), body last. */
export function buddyFileText(b: Buddy): string {
  const lines = HEADER_KEYS.map((k) => `${k}: ${JSON.stringify(b[k])}`)
  return `---\n${lines.join('\n')}\n---\n\n${b.instructions}\n`
}

/** Parses buddy.md into raw fields (clamped by the caller). Throws on a broken header. */
export function parseBuddyFile(text: string): Record<string, unknown> {
  const { data, body } = splitFrontmatter(text)
  const out: Record<string, YamlValue | string> = { ...data }
  out.instructions = body
  return out
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

const DEFAULT_RUN = BUDDY_DEFAULT_PER_RUN_USD
/** Imports from before this time kept the pack's folders and budget (imports limited since). */
const IMPORTS_LIMITED_AT = Date.parse('2026-10-02T02:00:00Z')

/** A pack marker of an import from before the import limits, not limited since. */
export function oldImport(marker: Record<string, unknown>): boolean {
  if (marker.limited === true) return false
  const at = typeof marker.installedAt === 'string' ? Date.parse(marker.installedAt) : NaN
  // No readable install time: treat it as old (limiting a new import changes nothing).
  return !(at >= IMPORTS_LIMITED_AT)
}

/** Writes buddy.md into a buddy folder as it is (the caller clamped it). */
export function writeBuddyFileAt(dir: string, b: Buddy): void {
  atomicWrite(join(dir, BUDDY_FILE), buddyFileText(b))
}

/** Keeps the newest lines that fit in `max` bytes. */
export function capNotebook(text: string, max = BUDDY_NOTEBOOK_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  const lines = text.split('\n')
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > max) lines.shift()
  const rest = lines.join('\n')
  return Buffer.byteLength(rest, 'utf8') <= max ? rest : ''
}

export class BuddyStore {
  constructor(
    readonly root: string,
    private readonly opts: BuddyStoreOptions = {}
  ) {}

  private dir(id: string): string {
    if (!isBuddyId(id)) throw new Error(`not a buddy id: ${id}`)
    return join(this.root, id)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  exists(id: string): boolean {
    return isBuddyId(id) && existsSync(join(this.root, id, BUDDY_FILE))
  }

  /**
   * The buddy's folder is there, even when its buddy.md cannot be read now (locked by a sync
   * tool, a broken header): only a missing folder means the buddy is gone.
   */
  hasFolder(id: string): boolean {
    return isBuddyId(id) && existsSync(join(this.root, id))
  }

  /** Imported (a pack marker in its folder): always community-untrusted. */
  imported(id: string): boolean {
    return isBuddyId(id) && existsSync(join(this.root, id, IMPORT_MARKER))
  }

  /** The buddy, validated and clamped; null when missing or unreadable. */
  get(id: string): Buddy | null {
    if (!this.exists(id)) return null
    try {
      const raw = parseBuddyFile(readFileSync(join(this.dir(id), BUDDY_FILE), 'utf8'))
      return clampBuddy(id, raw, {
        forceUntrusted: this.imported(id),
        now: this.now()
      })
    } catch (e) {
      console.warn(`[buddies] ${id}: ${(e as Error).message}`)
      return null
    }
  }

  list(): Buddy[] {
    if (!existsSync(this.root)) return []
    const out: Buddy[] = []
    for (const name of readdirSync(this.root)) {
      if (!isBuddyId(name)) continue
      const b = this.get(name)
      if (b) out.push(b)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  /**
   * Buddies imported before imports were limited keep no folders from the pack and a budget per
   * run no higher than the default: applied once (the marker remembers it), so what the user
   * changes later stays. Returns the ids it changed.
   */
  limitOldImports(): string[] {
    if (!existsSync(this.root)) return []
    const changed: string[] = []
    for (const id of readdirSync(this.root)) {
      if (!isBuddyId(id) || !this.imported(id)) continue
      const markerFile = join(this.root, id, IMPORT_MARKER)
      let marker: Record<string, unknown>
      try {
        marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      if (!oldImport(marker)) continue
      const b = this.get(id)
      if (!b) continue
      const p = b.permissions
      if (p.files.read.length || p.files.write.length || b.budget.perRunUsd > DEFAULT_RUN) {
        this.save({
          ...b,
          permissions: { ...p, files: { read: [], write: [] } },
          budget: { ...b.budget, perRunUsd: Math.min(b.budget.perRunUsd, DEFAULT_RUN) }
        })
        changed.push(id)
      }
      atomicWrite(markerFile, `${JSON.stringify({ ...marker, limited: true }, null, 2)}\n`)
    }
    return changed
  }

  /** Writes the buddy (clamped first; updatedAt now). Returns what was written. */
  save(b: Buddy): Buddy {
    const ctx = this.opts.clamp?.() ?? {}
    const held = this.get(b.id)
    const clean = clampBuddy(b.id, { ...b, updatedAt: this.now() } as Record<string, unknown>, {
      ...(ctx.connectors
        ? { connectors: [...ctx.connectors, ...(held?.permissions.connectors ?? [])] }
        : {}),
      ...(ctx.skills ? { skills: [...ctx.skills, ...(held?.skills ?? [])] } : {}),
      forceUntrusted: this.imported(b.id),
      now: this.now()
    })
    const dir = this.dir(b.id)
    mkdirSync(dir, { recursive: true })
    atomicWrite(join(dir, BUDDY_FILE), buddyFileText(clean))
    return clean
  }

  /** Another buddy (not `exceptId`) has this name, case and spacing ignored. */
  nameTaken(name: string, exceptId?: string): boolean {
    const key = buddyNameKey(name)
    return this.list().some((b) => b.id !== exceptId && buddyNameKey(b.name) === key)
  }

  /**
   * A new buddy of the user's own (trust mine) under a free id made from its name; a name another
   * buddy has gets a number ("Inbox Buddy 2").
   */
  create(fields: Partial<Omit<Buddy, 'id'>> & { name: string }): Buddy {
    const now = this.now()
    const name = freeBuddyName(fields.name, (n) => this.nameTaken(n))
    const id = buddyIdFor(name, (x) => existsSync(join(this.root, x)))
    const b = clampBuddy(
      id,
      { trust: 'mine', ...fields, name, createdAt: now, updatedAt: now },
      { ...this.opts.clamp?.(), now }
    )
    return this.save(b)
  }

  remove(id: string): boolean {
    if (!this.exists(id)) return false
    rmSync(this.dir(id), { recursive: true, force: true })
    return true
  }

  readNotebook(id: string): string {
    if (!this.exists(id)) return ''
    try {
      return readFileSync(join(this.dir(id), NOTEBOOK_FILE), 'utf8')
    } catch {
      return ''
    }
  }

  private canWrite(): boolean {
    return this.opts.canWrite?.() ?? true
  }

  /** Replaces the notebook (the user's edit). Too long is refused, not cut. */
  writeNotebook(id: string, text: string): NotebookWrite {
    if (!this.exists(id)) return 'missing'
    if (!this.canWrite()) return 'disabled'
    const clean = text.replace(/\r\n?/g, '\n')
    if (Buffer.byteLength(clean, 'utf8') > BUDDY_NOTEBOOK_MAX_BYTES) return 'too-long'
    atomicWrite(join(this.dir(id), NOTEBOOK_FILE), clean)
    return 'ok'
  }

  /** One dated line from a run (memory_write); the oldest lines go past 8 KB. */
  appendNotebook(id: string, fact: string): NotebookWrite {
    if (!this.exists(id)) return 'missing'
    if (!this.canWrite()) return 'disabled'
    const line = fact.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!line || this.opts.sensitive?.(line)) return 'rejected'
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const old = this.readNotebook(id).replace(/\n+$/, '')
    if (old.split('\n').some((l) => l.replace(/^- \d{4}-\d{2}-\d{2} /, '') === line)) return 'ok'
    const next = capNotebook(`${old ? `${old}\n` : ''}- ${day} ${line}\n`)
    atomicWrite(join(this.dir(id), NOTEBOOK_FILE), next)
    return 'ok'
  }
}
