// Where a made file goes and what it is called. Default: Documents\Lumen (created when
// missing); also Documents, Desktop, Downloads, the folder of the file it was made from, or a
// folder granted to background tasks. Never a network or device path, never outside those
// folders (links resolved), and never over an existing file unless the user confirmed: the
// next free "name (2).ext" is used instead. Pure apart from the injected file checks.
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { inside, isRemoteOrDevicePath } from '../agent-mode/background/files'
import type { Place } from './schema'

export interface Folders {
  documents: string
  desktop: string
  downloads: string
  /** Folders granted to background tasks (agent.background.readFolders, expanded). */
  granted: readonly string[]
}

export const LUMEN_FOLDER = 'Lumen'

export function defaultFolder(f: Pick<Folders, 'documents'>): string {
  return join(f.documents, LUMEN_FOLDER)
}

export type FolderResult = { ok: true; dir: string } | { ok: false; error: string }

/** The folder for `place`; next_to_source needs the source file's path. */
export function folderFor(place: Place, f: Folders, sourcePath?: string): FolderResult {
  switch (place) {
    case 'documents':
      return { ok: true, dir: f.documents }
    case 'desktop':
      return { ok: true, dir: f.desktop }
    case 'downloads':
      return { ok: true, dir: f.downloads }
    case 'next_to_source':
      return sourcePath
        ? { ok: true, dir: dirname(sourcePath) }
        : { ok: false, error: 'There is no original file to put it next to.' }
    default:
      return { ok: true, dir: defaultFolder(f) }
  }
}

/** The roots a made file may be written under (the source's folder only when there is one). */
export function writeRoots(f: Folders, sourcePath?: string): string[] {
  const roots = [f.documents, f.desktop, f.downloads, ...f.granted]
  if (sourcePath) roots.push(dirname(sourcePath))
  return roots.filter((r) => isAbsolute(r) && !isRemoteOrDevicePath(r)).map((r) => resolve(r))
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)$/i

/** A file name stem a model or a user said, made safe for Windows (no folders, no extension). */
export function safeStem(name: string, ext: string, fallback = 'Lumen document'): string {
  let s = name.replace(/[\\/]+/g, ' ').trim()
  if (s.toLowerCase().endsWith(ext.toLowerCase())) s = s.slice(0, -ext.length)
  s = s
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '')
    .slice(0, 80)
    .trim()
  if (!s || RESERVED.test(s) || RESERVED.test(s.split('.')[0])) return fallback
  return s
}

/**
 * Why `path` may not be written, or null. Lexical checks first (absolute, no network or device
 * path, no alternate data stream, inside a root), then `real` (links resolved) of its folder.
 */
export function writeProblem(
  path: string,
  roots: readonly string[],
  real: (p: string) => string | null
): string | null {
  if (isRemoteOrDevicePath(path) || !isAbsolute(path))
    return 'Network and device paths are not allowed.'
  // "C:\x\y.txt:stream" (alternate data stream) or a second drive colon.
  if (path.indexOf(':', 2) !== -1) return 'That is not a plain file path.'
  const full = resolve(path)
  if (!roots.some((r) => inside(r, full)))
    return 'I can only save into Documents, Desktop, Downloads or a folder you granted.'
  const dir = real(dirname(full))
  if (dir === null) return null
  if (isRemoteOrDevicePath(dir)) return 'Network and device paths are not allowed.'
  const realRoots = roots.map((r) => real(r) ?? r)
  if (!realRoots.some((r) => inside(r, join(dir, basename(full)))))
    return 'That folder links outside the folders I may save into.'
  return null
}

/** `dir\stem.ext`, else `dir\stem (2).ext`, … (null after 999 tries). */
export function freePath(
  dir: string,
  stem: string,
  ext: string,
  exists: (p: string) => boolean
): string | null {
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, `${stem}${n === 1 ? '' : ` (${n})`}${ext}`)
    if (!exists(p)) return p
  }
  return null
}

/** "report.final.docx" → "report.final" (the name without its extension). */
export const stemOf = (name: string): string => basename(name, extname(name))
