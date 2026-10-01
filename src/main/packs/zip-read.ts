// A small, strict zip reader for `.lumen` packs (stored and deflate entries, no zip64, no
// encryption). Everything is checked before anything is unpacked: entry count, total and
// per-entry sizes, safe relative names (no "..", no absolute or drive paths, no backslashes,
// no control characters), no symlinks, no duplicate names (case-insensitive, as on Windows),
// and the CRC of every inflated entry. Pure: works on a Buffer, never touches the disk.
import { crc32, inflateRawSync } from 'zlib'

export interface ZipLimits {
  /** Largest archive and largest total unpacked size, in bytes. */
  maxBytes: number
  maxEntries: number
}

export const ZIP_LIMITS: ZipLimits = { maxBytes: 50 * 1024 * 1024, maxEntries: 2000 }

export interface ZipFile {
  /** Forward-slash relative path, e.g. "blender/lessons/blender-add.lesson.json". */
  name: string
  data: Buffer
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const HOST_UNIX = 3

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i
  throw new ZipError('not a zip file')
}

/** Why `name` is unsafe to unpack, or null when it is a plain relative path. */
export function unsafeName(name: string): string | null {
  if (!name) return 'empty name'
  if (name.length > 240) return 'name too long'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'control character in name'
  if (name.includes('\\')) return 'backslash in name'
  if (name.startsWith('/')) return 'absolute path'
  if (/^[a-zA-Z]:/.test(name)) return 'drive path'
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'relative segment in name'
  // Windows device names and trailing dots / spaces resolve to something else on disk.
  if (parts.some((p) => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p) || /[. ]$/.test(p)))
    return 'reserved name'
  if (parts.some((p) => /[<>:"|?*]/.test(p))) return 'invalid character in name'
  return null
}

/**
 * The files in `buf` (directory entries are dropped). Throws ZipError on anything unsafe or
 * malformed; nothing partial is returned.
 */
export function readZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipFile[] {
  if (buf.length > limits.maxBytes) throw new ZipError('archive is too large')
  if (buf.length < EOCD_MIN) throw new ZipError('not a zip file')
  const eocd = findEocd(buf)
  const disk = buf.readUInt16LE(eocd + 4)
  const count = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  const dirOffset = buf.readUInt32LE(eocd + 16)
  if (disk !== 0 || buf.readUInt16LE(eocd + 8) !== count)
    throw new ZipError('multi-part archives are not supported')
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('zip64 is not supported')
  if (count > limits.maxEntries) throw new ZipError(`too many entries (${count})`)
  if (dirOffset + dirSize > eocd) throw new ZipError('corrupt central directory')

  const seen = new Set<string>()
  const out: ZipFile[] = []
  let total = 0
  let p = dirOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG)
      throw new ZipError('corrupt central directory')
    const madeBy = buf.readUInt16LE(p + 4)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    const bad = unsafeName(name)
    if (bad) throw new ZipError(`${bad}: ${JSON.stringify(name.slice(0, 80))}`)
    if (flags & 0x0001) throw new ZipError(`encrypted entry: ${name}`)
    if (madeBy >> 8 === HOST_UNIX && ((external >>> 16) & S_IFMT) === S_IFLNK)
      throw new ZipError(`symbolic link: ${name}`)
    if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipError('zip64 is not supported')
    const key = name.replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) throw new ZipError(`duplicate entry: ${name}`)
    seen.add(key)
    if (name.endsWith('/')) continue

    total += size
    if (size > limits.maxBytes || total > limits.maxBytes)
      throw new ZipError('archive unpacks to more than the size limit')
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${name}`)

    if (localOffset + 30 > dirOffset || buf.readUInt32LE(localOffset) !== LOCAL_SIG)
      throw new ZipError(`corrupt entry: ${name}`)
    const start =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (start + packed > dirOffset) throw new ZipError(`corrupt entry: ${name}`)
    const raw = buf.subarray(start, start + packed)
    let data: Buffer
    try {
      // maxOutputLength stops a deflate bomb that lies about its size.
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: size || 1 })
    } catch {
      throw new ZipError(`corrupt entry: ${name}`)
    }
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`corrupt entry: ${name}`)
    out.push({ name, data })
  }
  return out
}
