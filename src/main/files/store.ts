// Files dropped on the assistant bar (08 T21). A drop registers the file for the current
// conversation only: nothing is read or uploaded until a request is about it (attach.ts), and
// the agent's read_file reaches only these ids. The list clears when the conversation ends.
import { randomBytes } from 'crypto'
import { open, realpath, stat } from 'fs/promises'
import { basename, extname, isAbsolute } from 'path'
import type { DroppedFileView } from '@shared/channels'

export type FileKind = DroppedFileView['kind']

export interface SharedFile extends DroppedFileView {
  /** Real path (links resolved) checked at drop time. */
  path: string
  /** Not yet seen by a request (the next "summarize this" means this file). */
  fresh: boolean
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_FILES = 5

const KIND_BY_EXT: Record<string, FileKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'text',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image'
}

export const ALLOWED_EXTENSIONS = Object.keys(KIND_BY_EXT)

export type CheckResult =
  | { ok: true; path: string; name: string; size: number; kind: FileKind }
  | { ok: false; error: string }

const deny = (error: string): CheckResult => ({ ok: false, error })

const startsWith = (buf: Buffer, bytes: number[]): boolean => bytes.every((b, i) => buf[i] === b)

/** Does the head of the file match its extension (no renamed executables or archives)? */
export function contentMatches(kind: FileKind, ext: string, head: Buffer): boolean {
  if (kind === 'pdf') return head.subarray(0, 1024).includes('%PDF-')
  if (kind === 'docx') return startsWith(head, [0x50, 0x4b, 0x03, 0x04])
  if (kind === 'image')
    return ext === '.png'
      ? startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : startsWith(head, [0xff, 0xd8, 0xff])
  // Text: UTF-16 with a BOM, else no NUL bytes (binary files have them early).
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true
  return !head.includes(0)
}

async function readHead(path: string, bytes = 8192): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Checks a dropped path: absolute and local (no UNC or device paths), a regular file after
 * resolving links, 1 byte to 50 MB, an allowed extension, and content that matches it.
 */
export async function checkDroppedPath(raw: string): Promise<CheckResult> {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return deny('That is not a file path.')
  if (/^[\\/]{2}/.test(raw))
    return deny('Network and device paths are not supported. Copy the file to this PC first.')
  if (!isAbsolute(raw)) return deny('That is not a file path.')
  let path: string
  try {
    path = await realpath(raw)
  } catch {
    return deny('I could not find that file.')
  }
  if (/^[\\/]{2}/.test(path))
    return deny('Network and device paths are not supported. Copy the file to this PC first.')
  const ext = extname(path).toLowerCase()
  const kind = KIND_BY_EXT[ext]
  if (!kind) return deny('I can read PDF, Word (.docx), text, Markdown, CSV, PNG and JPG files.')
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return deny('That is not a file.')
    size = st.size
  } catch {
    return deny('I could not open that file.')
  }
  if (size === 0) return deny('That file is empty.')
  if (size > MAX_FILE_BYTES) return deny('That file is over 50 MB.')
  let head: Buffer
  try {
    head = await readHead(path)
  } catch {
    return deny('I could not open that file.')
  }
  if (!contentMatches(kind, ext, head))
    return deny(`That file does not look like a real ${ext.slice(1).toUpperCase()} file.`)
  return { ok: true, path, name: basename(path), size, kind }
}

const files = new Map<string, SharedFile>()

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export const view = (f: SharedFile): DroppedFileView => ({
  id: f.id,
  name: f.name,
  size: f.size,
  kind: f.kind
})

export function listFiles(): DroppedFileView[] {
  return [...files.values()].map(view)
}

export function sharedFiles(): SharedFile[] {
  return [...files.values()]
}

export function getFile(id: string): SharedFile | undefined {
  return files.get(id)
}

export type RegisterResult = { ok: true; file: SharedFile } | { ok: false; error: string }

/** Registers a dropped file for this conversation (the same file twice stays one entry). */
export async function registerFile(path: string): Promise<RegisterResult> {
  const r = await checkDroppedPath(path)
  if (!r.ok) return r
  const existing = [...files.values()].find((f) => samePath(f.path, r.path))
  if (existing) {
    existing.fresh = true
    return { ok: true, file: existing }
  }
  if (files.size >= MAX_FILES)
    return { ok: false, error: `Up to ${MAX_FILES} files at a time. Remove one first.` }
  const file: SharedFile = {
    id: `f_${randomBytes(5).toString('hex')}`,
    name: r.name,
    size: r.size,
    kind: r.kind,
    path: r.path,
    fresh: true
  }
  files.set(file.id, file)
  return { ok: true, file }
}

export function removeFile(id: string): boolean {
  return files.delete(id)
}

/** The conversation ended ("new topic", idle, quit): forget every file. */
export function clearFiles(): void {
  files.clear()
}
