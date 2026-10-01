// The folder of a "when a file lands in X" automation: a known folder name or an existing local
// directory. It is shared with background tasks (read_file) and watched, so network and device
// paths, drive roots and Lumen's own data folders are refused.
import { isAbsolute, parse, resolve } from 'path'
import { expandRoot, inside, isRemoteOrDevicePath } from '../agent-mode/background/files'

export interface FolderPorts {
  /** "downloads" → the user's Downloads folder, else null. */
  known(name: string): string | null
  isDir(path: string): boolean
  /** Symlinks resolved. */
  real(path: string): string
  /** Lumen's data folders (~/.ai-overlay, %APPDATA%/Lumen). */
  dataDirs(): string[]
}

function refused(p: string, dataDirs: string[]): boolean {
  if (isRemoteOrDevicePath(p) || !isAbsolute(p)) return true
  const full = resolve(p)
  if (parse(full).root === full) return true
  return dataDirs.some((d) => {
    const dir = resolve(d)
    return dir.toLowerCase() === full.toLowerCase() || inside(dir, full) || inside(full, dir)
  })
}

export function resolveFolderWith(name: string, ports: FolderPorts): string | null {
  const n = name
    .trim()
    .replace(/^(?:my|the) /i, '')
    .replace(/ folder$/i, '')
  try {
    const known = ports.known(n.toLowerCase())
    if (known) return known
    const p = expandRoot(n)
    if (!p || refused(p, ports.dataDirs())) return null
    if (!ports.isDir(p)) return null
    const real = ports.real(p)
    return refused(real, ports.dataDirs()) ? null : real
  } catch {
    return null
  }
}

/** A saved folder that may be shared and watched (a hand-edited file is checked again). */
export function folderAllowed(path: string, dataDirs: string[]): boolean {
  return !refused(path, dataDirs)
}
