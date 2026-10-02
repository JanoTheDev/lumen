// Buddies as `.lumen` packs (08 T51): one pack folder per buddy holding only buddy.md (header +
// instructions). Export leaves out everything private or local: the notebook (memory.md), its
// schedule ids, folders (paths of this PC) and its trust. An import installs through the
// generic pack installer into ~/.ai-overlay/buddies with a `.lumen-pack.json` marker, so the
// buddy store keeps it community-untrusted (every connector / on-screen action confirms). A
// buddy whose name the user already has gets a free id instead of replacing theirs. No Electron.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Buddy } from '@shared/buddies'
import { buddyIdFor, clampBuddy, isBuddyId } from '../buddies/clamp'
import { BUDDY_FILE, buddyFileText, IMPORT_MARKER, parseBuddyFile } from '../buddies/store'
import { installPacks, planPacks, type PackKind } from './install'
import { readZip, ZIP_LIMITS } from './zip-read'
import { zip } from './zip-write'

export const BUDDY_PACK_KIND = 'buddy'

export interface BuddyKindOptions {
  /** A folder with this id exists that is not an earlier import (the user's own buddy). */
  ownTaken?: (id: string) => boolean
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
      return problems
    }
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
function kindFor(root: string): PackKind {
  return buddyPackKind({
    ownTaken: (id) => existsSync(join(root, id)) && !existsSync(join(root, id, IMPORT_MARKER))
  })
}

/** The buddies in an archive, with the ids they would install under. Throws PackError. */
export function planBuddyArchive(
  archive: Buffer,
  root: string
): { id: string; buddy: Buddy; updates: boolean }[] {
  return planPacks(readZip(archive, ZIP_LIMITS), kindFor(root)).map((p) => {
    const file = p.files.find((f) => f.name === BUDDY_FILE)!
    return {
      id: p.id,
      buddy: buddyFromPackFile(file.data.toString('utf8'), p.id),
      updates: existsSync(join(root, p.id))
    }
  })
}

/** Installs every buddy in the archive (marker: community-untrusted). Throws PackError. */
export function installBuddyArchive(
  archive: Buffer,
  source: string,
  root: string
): { id: string; name: string; updated: boolean }[] {
  return installPacks(archive, { kind: kindFor(root), destRoot: root, source }).map((p) => ({
    id: p.id,
    name: buddyFromPackFile(readFileSync(join(p.dir, BUDDY_FILE), 'utf8'), p.id).name,
    updated: p.updated
  }))
}
