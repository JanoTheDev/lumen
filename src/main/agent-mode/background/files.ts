// read_file for background tasks: only text files inside a granted folder (config
// agent.background.readFolders or the skill's files.read). Symlinks and ".." are resolved
// before the check, so a link out of a granted folder is refused too.
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { extname, isAbsolute, relative, resolve } from 'path'

export const READ_MAX_BYTES = 256 * 1024
const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.srt',
  '.vtt'
])

export type ReadResult = { ok: true; path: string; text: string } | { ok: false; error: string }

/** "~/Documents" → absolute; anything relative is not a grant. */
export function expandRoot(root: string): string | null {
  const r = root.trim().replace(/^~(?=$|[\\/])/, homedir())
  return isAbsolute(r) ? resolve(r) : null
}

function real(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/** Is `file` (already real) inside `root` (already real)? Case-insensitive on Windows. */
export function inside(root: string, file: string): boolean {
  const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rel = relative(norm(root), norm(file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export function readGranted(path: string, roots: readonly string[]): ReadResult {
  if (!isAbsolute(path)) return { ok: false, error: 'E_DENIED: give an absolute path.' }
  const realRoots = roots
    .map(expandRoot)
    .filter((r): r is string => !!r && existsSync(r))
    .map(real)
    .filter((r): r is string => !!r)
  if (!realRoots.length)
    return { ok: false, error: 'E_DENIED: no folders are granted to background tasks.' }
  const file = real(resolve(path))
  if (!file) return { ok: false, error: 'File not found.' }
  if (!realRoots.some((r) => inside(r, file)))
    return { ok: false, error: 'E_DENIED: that file is outside the granted folders.' }
  if (!TEXT_EXT.has(extname(file).toLowerCase()))
    return { ok: false, error: 'E_DENIED: only text files can be read.' }
  const st = statSync(file)
  if (!st.isFile()) return { ok: false, error: 'Not a file.' }
  const buf = readFileSync(file)
  const cut = buf.byteLength > READ_MAX_BYTES
  const text = buf.subarray(0, READ_MAX_BYTES).toString('utf8')
  return { ok: true, path: file, text: cut ? `${text}\n[cut at 256 KB]` : text }
}
