// Buddies as `.lumen` packs (08 T51): one pack folder per buddy holding only buddy.md (header +
// instructions). Export leaves out everything private or local: the notebook (memory.md), its
// schedule ids, folders (paths of this PC) and its trust. An import installs through the
// generic pack installer into ~/.ai-overlay/buddies with a `.lumen-pack.json` marker, so the
// buddy store keeps it community-untrusted (every connector / on-screen action confirms). An
// import never keeps folders from the file (the user adds them in Settings) and its budget per
// run is at most the default. A buddy whose name the user already has gets a free id instead
// of replacing theirs. No Electron.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { BUDDY_DEFAULT_PER_RUN_USD, type Buddy } from '@shared/buddies'
import {
  buddyIdFor,
  buddyNameKey,
  clampBuddy,
  freeBuddyName,
  isBuddyId,
  type ClampContext
} from '../buddies/clamp'
import {
  BUDDY_FILE,
  BuddyStore,
  buddyFileText,
  IMPORT_MARKER,
  parseBuddyFile,
  writeBuddyFileAt
} from '../buddies/store'
import { installPacks, planPacks, type PackKind } from './install'
import { readZip, ZIP_LIMITS } from './zip-read'
import { zip } from './zip-write'

export const BUDDY_PACK_KIND = 'buddy'

export interface BuddyKindOptions {
  /** A folder with this id exists that is not an earlier import (the user's own buddy). */
  ownTaken?: (id: string) => boolean
  /**
   * Rewrites the staged buddy.md once it is valid, before any folder is installed: an import
   * never makes the pack's own file visible, and a failed rewrite installs nothing.
   */
  rewrite?: (dir: string, id: string) => void
}

/** The buddy's header + instructions from a pack's buddy.md (clamped, untrusted). */
export function buddyFromPackFile(text: string, id = 'imported'): Buddy {
  const raw = parseBuddyFile(text)
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('buddy.md has no name')
  return clampBuddy(id, raw, { forceUntrusted: true })
}

export function buddyPackKind(opts: BuddyKindOptions = {}): PackKind {
  return {
    name: BUDDY_PACK_KIND,
    manifest: BUDDY_FILE,
    allowedExt: ['.md'],
    idOf(manifest) {
      const b = buddyFromPackFile(manifest.toString('utf8'))
      return buddyIdFor(b.name, (id) => !!opts.ownTaken?.(id))
    },
    reserved(id) {
      return isBuddyId(id) ? null : `"${id}" is not a buddy name`
    },
    validate(dir) {
      const problems: string[] = []
      for (const f of readdirSync(dir))
        if (f !== BUDDY_FILE) problems.push(`${f}: a buddy pack holds only ${BUDDY_FILE}`)
      try {
        buddyFromPackFile(readFileSync(join(dir, BUDDY_FILE), 'utf8'))
      } catch (e) {
        problems.push(`${BUDDY_FILE}: ${(e as Error).message}`)
      }
      if (!problems.length) opts.rewrite?.(dir, basename(dir))
      return problems
    }
  }
}

/**
 * What an import keeps of a pack's buddy: no folders (paths on someone else's PC; a hand-made
 * file could name any), a budget per run no higher than the default, only connectors and skills
 * that exist here (`known`; left out = not checked). `notes` say what was left out, for the
 * import preview.
 */
export function importedBuddy(
  b: Buddy,
  nameTaken: (name: string) => boolean = () => false,
  known: ClampContext = {}
): { buddy: Buddy; notes: string[] } {
  const notes: string[] = []
  const keep = (list: string[], have?: readonly string[]): [string[], string[]] =>
    have
      ? [list.filter((x) => have.includes(x)), list.filter((x) => !have.includes(x))]
      : [list, []]
  const [connectors, noConnectors] = keep(b.permissions.connectors, known.connectors)
  if (noConnectors.length)
    notes.push(`Left out connectors that are not set up: ${noConnectors.join(', ')}.`)
  const [skills, noSkills] = keep(b.skills, known.skills)
  if (noSkills.length) notes.push(`Left out skills that are not installed: ${noSkills.join(', ')}.`)
  const name = freeBuddyName(b.name, nameTaken)
  if (name !== b.name) notes.push(`Named “${name}”: you already have a buddy called ${b.name}.`)
  const { read, write } = b.permissions.files
  if (read.length || write.length)
    notes.push(
      `Folders in the file were left out (${[...read, ...write].join(', ')}). Add folders in its settings after the import if it needs them.`
    )
  const perRunUsd = Math.min(b.budget.perRunUsd, BUDDY_DEFAULT_PER_RUN_USD)
  if (perRunUsd < b.budget.perRunUsd)
    notes.push(
      `Its budget per run was lowered from $${b.budget.perRunUsd.toFixed(2)} to $${perRunUsd.toFixed(2)}.`
    )
  return {
    buddy: {
      ...b,
      name,
      permissions: { ...b.permissions, connectors, files: { read: [], write: [] } },
      skills,
      budget: { ...b.budget, perRunUsd },
      scheduleIds: [],
      trust: 'community-untrusted'
    },
    notes
  }
}

/** What leaves this PC: no notebook, schedules, folders or trust. */
export function exportableBuddy(b: Buddy): Buddy {
  return {
    ...b,
    permissions: { ...b.permissions, files: { read: [], write: [] } },
    scheduleIds: [],
    trust: 'community-untrusted',
    enabled: true
  }
}

/** A `.lumen` archive of buddies (one folder each, buddy.md only). */
export function exportBuddies(list: Buddy[]): Buffer {
  return zip(
    list.map((b) => ({
      name: `${b.id}/${BUDDY_FILE}`,
      data: Buffer.from(buddyFileText(exportableBuddy(b)), 'utf8')
    }))
  )
}

/** The kind for the buddies folder `root`: the user's own buddies are never replaced. */
function kindFor(root: string, rewrite?: BuddyKindOptions['rewrite']): PackKind {
  return buddyPackKind({
    ownTaken: (id) => existsSync(join(root, id)) && !existsSync(join(root, id, IMPORT_MARKER)),
    ...(rewrite ? { rewrite } : {})
  })
}

/** The buddies in an archive, with the ids they would install under. Throws PackError. */
export function planBuddyArchive(
  archive: Buffer,
  root: string,
  known: ClampContext = {}
): { id: string; buddy: Buddy; updates: boolean; notes: string[] }[] {
  const packs = planPacks(readZip(archive, ZIP_LIMITS), kindFor(root))
  // Names stay unique: not one of the user's other buddies (an earlier import this replaces
  // does not count), nor one given earlier in this archive.
  const replaced = new Set(packs.map((p) => p.id))
  const names = new BuddyStore(root)
    .list()
    .filter((b) => !replaced.has(b.id))
    .map((b) => buddyNameKey(b.name))
  return packs.map((p) => {
    const file = p.files.find((f) => f.name === BUDDY_FILE)!
    const raw = buddyFromPackFile(file.data.toString('utf8'), p.id)
    const { buddy, notes } = importedBuddy(raw, (n) => names.includes(buddyNameKey(n)), known)
    names.push(buddyNameKey(buddy.name))
    return { id: p.id, buddy, updates: existsSync(join(root, p.id)), notes }
  })
}

/**
 * Installs every buddy in the archive (marker: community-untrusted), each written as the plan
 * shows it (no folders, budget capped). Throws PackError.
 */
export function installBuddyArchive(
  archive: Buffer,
  source: string,
  root: string,
  known: ClampContext = {}
): { id: string; name: string; updated: boolean }[] {
  const plan = new Map(planBuddyArchive(archive, root, known).map((p) => [p.id, p.buddy]))
  // Each buddy.md is rewritten in the staging folder, before it is installed.
  const rewrite = (dir: string, id: string): void => {
    const b =
      plan.get(id) ??
      importedBuddy(
        buddyFromPackFile(readFileSync(join(dir, BUDDY_FILE), 'utf8'), id),
        () => false,
        known
      ).buddy
    plan.set(id, b)
    writeBuddyFileAt(dir, b)
  }
  return installPacks(archive, { kind: kindFor(root, rewrite), destRoot: root, source }).map(
    (p) => ({ id: p.id, name: plan.get(p.id)?.name ?? p.id, updated: p.updated })
  )
}
