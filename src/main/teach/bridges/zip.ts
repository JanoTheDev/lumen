// A small zip writer (deflate, no zip64) for packing the Blender add-on folder into the file
// Blender's "Install from Disk" takes. Entries keep forward-slash paths under `prefix/`.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { crc32, deflateRawSync } from 'zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

/** Files under `dir` (skipping __pycache__ and dotfiles), named `prefix/<relative path>`. */
export function folderEntries(dir: string, prefix: string): ZipEntry[] {
  const out: ZipEntry[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === '__pycache__') continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else
        out.push({
          name: `${prefix}/${relative(dir, p).replace(/\\/g, '/')}`,
          data: readFileSync(p)
        })
    }
  }
  walk(dir)
  return out
}

// DOS date/time of 1980-01-01 00:00 keeps the archive byte-identical between builds.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const packed = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
