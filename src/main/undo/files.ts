// File undo (11 T16): before Lumen overwrites, moves or deletes a file it copies it into
// ~/.ai-overlay/undo-trash/<id>/; "undo that" copies it back. A file Lumen created is moved
// into the trash on undo (never deleted outright). Copies older than a day are pruned.
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync
} from 'fs'
import { basename, dirname, join } from 'path'

const DAY_MS = 86_400_000
const MAX_BYTES = 200 * 1024 * 1024

export class UndoTrash {
  constructor(private readonly dir: string) {}

  /**
   * Copies `path` into the trash under `id`. Returns the copy's path, null when the file does
   * not exist (Lumen is about to create it), or throws when it is too big to keep.
   */
  backup(path: string, id: string): string | null {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile()) throw new Error('only single files can be kept for undo')
    if (st.size > MAX_BYTES) throw new Error('the file is too big to keep a copy for undo')
    const slot = join(this.dir, id)
    mkdirSync(slot, { recursive: true })
    const copy = join(slot, basename(path))
    copyFileSync(path, copy)
    return copy
  }

  /** Puts a file back: the kept copy over `path`, or (backup null) `path` into the trash. */
  restore(path: string, backup: string | null, id: string): void {
    if (backup) {
      if (!existsSync(backup)) throw new Error('the kept copy is gone')
      mkdirSync(dirname(path), { recursive: true })
      copyFileSync(backup, path)
      return
    }
    if (!existsSync(path)) return
    const slot = join(this.dir, `${id}-created`)
    mkdirSync(slot, { recursive: true })
    renameSync(path, join(slot, basename(path)))
  }

  /** A file Lumen renamed or moved goes back from `movedTo` to `path`, never over a file. */
  moveBack(path: string, movedTo: string): void {
    if (!existsSync(movedTo)) throw new Error('the file is no longer where I put it')
    if (existsSync(path)) throw new Error('another file now has its old name')
    moveNoReplaceSync(movedTo, path)
  }

  /** Drops the copy kept under `id` (the change it was kept for did not happen). */
  drop(id: string): void {
    rmSync(join(this.dir, id), { recursive: true, force: true })
  }

  /** Drops copies older than `maxAgeMs`. */
  prune(now = Date.now(), maxAgeMs = DAY_MS): number {
    if (!existsSync(this.dir)) return 0
    let n = 0
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name)
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) {
          rmSync(p, { recursive: true, force: true })
          n++
        }
      } catch {
        /* raced with another prune */
      }
    }
    return n
  }
}

/**
 * Moves a file without ever replacing one at `to` (fs.rename replaces on Windows): a hard
 * link (EEXIST when taken) then the old name is removed; where links are not supported, an
 * exclusive copy then the old name is removed.
 */
export function moveNoReplaceSync(from: string, to: string): void {
  try {
    linkSync(from, to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOENT' || code === 'EXDEV') throw e
    copyFileSync(from, to, constants.COPYFILE_EXCL)
  }
  try {
    unlinkSync(from)
  } catch (e) {
    unlinkSync(to)
    throw e
  }
}
