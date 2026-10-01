// Generic `.lumen` pack install / export / remove (07 T32; 11 T06 reuses it for skills). A
// `.lumen` file is a zip of one or more pack folders, each with a manifest file at its root
// (skill packs: skill.json). The PackKind says which manifest, which file types a pack may
// hold (data only: never scripts or executables), which ids are reserved and how to validate
// an unpacked pack. Install is all-or-nothing: every pack in the archive is unpacked into a
// staging folder and validated before any of them replaces an installed folder. Installed
// packs get a `.lumen-pack.json` marker (trust "community-untrusted", source, hash); only
// marked folders are ever replaced or removed, so the user's own packs are never touched.
// No Electron.
import { createHash, randomBytes } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, extname, join, resolve, sep } from 'path'
import { readZip, ZIP_LIMITS, type ZipFile, type ZipLimits } from './zip-read'
import { folderEntries, zip, type ZipEntry } from './zip-write'

export const MARKER_FILE = '.lumen-pack.json'
export const PACK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** Pack roots may sit at most this deep in the archive ("<repo>-main/<pack>/skill.json"). */
const MAX_ROOT_DEPTH = 2

export type PackTrust = 'community-untrusted'

export interface PackMarker {
  format: 1
  kind: string
  id: string
  trust: PackTrust
  /** File name or URL it came from. */
  source: string
  /** SHA-256 of the archive. */
  sha256: string
  installedAt: string
}

export interface PackKind {
  /** "skill"; stored in the marker. */
  name: string
  /** File at the root of every pack folder, e.g. "skill.json". */
  manifest: string
  /** Allowed file extensions (lowercase, with the dot). */
  allowedExt: readonly string[]
  /** Allowed extension-less file names (LICENSE, NOTICE …). */
  plainNames?: readonly string[]
  /** The pack id from the manifest; throws when it has none. */
  idOf(manifest: Buffer): string
  /** Why `id` cannot be installed (a bundled pack, a folder the app uses), or null. */
  reserved(id: string): string | null
  /** Problems with the unpacked pack at `dir` (whose folder name is its id); [] = valid. */
  validate(dir: string): string[]
}

export class PackError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = []
  ) {
    super(message)
  }
}

export interface PlannedPack {
  id: string
  /** The folder prefix inside the archive ("" or "x/" or "x/y/"). */
  root: string
  /** Files relative to the pack folder. */
  files: ZipFile[]
}

const isHidden = (rel: string): boolean => rel.split('/').some((p) => p.startsWith('.'))

function allowedFile(kind: PackKind, rel: string): boolean {
  const base = rel.split('/').pop()!
  const ext = extname(base).toLowerCase()
  if (!ext) return !!kind.plainNames?.includes(base.toUpperCase())
  return kind.allowedExt.includes(ext)
}

/**
 * The packs in an archive's files. `subpath` (a GitHub tree link's folder) keeps only files
 * under "<top folder>/<subpath>/". Files outside every pack (a repo's README) are ignored;
 * hidden files inside a pack are skipped; any other file type inside a pack fails the install.
 */
export function planPacks(files: ZipFile[], kind: PackKind, subpath?: string): PlannedPack[] {
  let list = files
  if (subpath) {
    const sub = subpath.replace(/^\/+|\/+$/g, '')
    list = files.flatMap((f) => {
      const rest = f.name.slice(f.name.indexOf('/') + 1)
      return f.name.includes('/') && rest.startsWith(`${sub}/`)
        ? [{ name: rest.slice(sub.length + 1), data: f.data }]
        : []
    })
  }
  const roots = list
    .filter((f) => f.name.split('/').pop() === kind.manifest && !isHidden(f.name))
    .map((f) => f.name.slice(0, f.name.length - kind.manifest.length))
    .filter((root) => root.split('/').length - 1 <= MAX_ROOT_DEPTH)
  if (!roots.length) throw new PackError(`no ${kind.name} pack (${kind.manifest}) in the file`)
  for (const a of roots)
    for (const b of roots)
      if (a !== b && b.startsWith(a)) throw new PackError(`a pack inside another pack: ${b}`)

  const problems: string[] = []
  const seen = new Set<string>()
  const packs = roots.map((root): PlannedPack => {
    const manifest = list.find((f) => f.name === `${root}${kind.manifest}`)!
    let id = ''
    try {
      id = kind.idOf(manifest.data)
    } catch (e) {
      problems.push(`${root}${kind.manifest}: ${(e as Error).message}`)
    }
    if (id && !PACK_ID_RE.test(id)) problems.push(`${root}${kind.manifest}: bad id "${id}"`)
    if (id && seen.has(id)) problems.push(`two packs named "${id}"`)
    seen.add(id)
    const reason = id ? kind.reserved(id) : null
    if (reason) problems.push(reason)
    const own: ZipFile[] = []
    for (const f of list) {
      if (!f.name.startsWith(root)) continue
      const rel = f.name.slice(root.length)
      if (isHidden(rel)) continue
      if (!allowedFile(kind, rel)) problems.push(`not allowed in a pack (data only): ${f.name}`)
      else own.push({ name: rel, data: f.data })
    }
    return { id, root, files: own }
  })
  if (problems.length) throw new PackError('the pack is not valid', problems)
  return packs
}

function readMarker(dir: string): PackMarker | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as PackMarker
    return m && m.format === 1 && typeof m.id === 'string' ? m : null
  } catch {
    return null
  }
}

/** The file inside `dir` for an archive name; null when it would land outside `dir`. */
function inside(dir: string, rel: string): string | null {
  const root = resolve(dir)
  const file = resolve(root, ...rel.split('/'))
  return file.startsWith(root + sep) ? file : null
}

export interface InstallOptions {
  kind: PackKind
  /** Where pack folders live (e.g. ~/.ai-overlay/skills). */
  destRoot: string
  /** File name or URL, kept in the marker. */
  source: string
  subpath?: string
  limits?: ZipLimits
  now?: () => Date
}

export interface InstalledPack {
  id: string
  dir: string
  /** It replaced an earlier install of the same pack. */
  updated: boolean
}

/** Unpacks, validates and installs every pack in `archive`. Throws PackError; nothing changes then. */
export function installPacks(archive: Buffer, opts: InstallOptions): InstalledPack[] {
  const { kind, destRoot } = opts
  let files: ZipFile[]
  try {
    files = readZip(archive, opts.limits ?? ZIP_LIMITS)
  } catch (e) {
    throw new PackError(`not a usable pack file: ${(e as Error).message}`)
  }
  const packs = planPacks(files, kind, opts.subpath)

  for (const p of packs) {
    const dest = join(destRoot, p.id)
    if (existsSync(dest) && !readMarker(dest))
      throw new PackError(`you already have your own pack named "${p.id}"; it was left as it is`)
  }

  mkdirSync(destRoot, { recursive: true })
  const staging = join(destRoot, `.staging-${randomBytes(6).toString('hex')}`)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  try {
    const problems: string[] = []
    for (const p of packs) {
      const dir = join(staging, p.id)
      for (const f of p.files) {
        const file = inside(dir, f.name)
        if (!file) throw new PackError(`unsafe path in pack: ${f.name}`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, f.data, { flag: 'wx' })
      }
      for (const msg of kind.validate(dir)) problems.push(`${p.id}: ${msg}`)
    }
    if (problems.length) throw new PackError('the pack is not valid', problems)

    const out: InstalledPack[] = []
    for (const p of packs) {
      const dir = join(staging, p.id)
      const marker: PackMarker = {
        format: 1,
        kind: kind.name,
        id: p.id,
        trust: 'community-untrusted',
        source: opts.source.slice(0, 500),
        sha256,
        installedAt: (opts.now?.() ?? new Date()).toISOString()
      }
      writeFileSync(join(dir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      const dest = join(destRoot, p.id)
      const updated = existsSync(dest)
      if (updated) rmSync(dest, { recursive: true, force: true })
      renameSync(dir, dest)
      out.push({ id: p.id, dir: dest, updated })
    }
    return out
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export interface InstalledInfo extends PackMarker {
  dir: string
}

/** Installed (marked) packs of `kind` under `destRoot`. */
export function installedPacks(destRoot: string, kind?: string): InstalledInfo[] {
  if (!existsSync(destRoot)) return []
  const out: InstalledInfo[] = []
  for (const name of readdirSync(destRoot).sort()) {
    const dir = join(destRoot, name)
    if (name.startsWith('.') || !isDir(dir)) continue
    const m = readMarker(dir)
    if (m && m.id === name && (!kind || m.kind === kind)) out.push({ ...m, dir })
  }
  return out
}

/** The marker of the pack folder `dir`, or null for the user's own / bundled packs. */
export function packMarker(dir: string): PackMarker | null {
  return readMarker(dir)
}

/** Removes an installed pack; never a folder without a marker. */
export function removePack(destRoot: string, id: string): boolean {
  if (!PACK_ID_RE.test(id)) return false
  const dir = join(destRoot, id)
  if (!readMarker(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** A `.lumen` archive of the pack folders in `dirs` (hidden files and other types left out). */
export function exportPacks(dirs: string[], kind: PackKind): Buffer {
  const entries: ZipEntry[] = []
  for (const dir of dirs) {
    const id = dir.split(/[\\/]/).pop()!
    if (!existsSync(join(dir, kind.manifest))) throw new PackError(`${id} has no ${kind.manifest}`)
    for (const e of folderEntries(dir, id))
      if (allowedFile(kind, e.name.slice(id.length + 1))) entries.push(e)
  }
  return zip(entries)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
