import { describe, expect, it } from 'vitest'
import { readZip, unsafeName, ZipError } from '../../src/main/packs/zip-read'
import { zip } from '../../src/main/packs/zip-write'

const file = (name: string, text = 'x'): { name: string; data: Buffer } => ({
  name,
  data: Buffer.from(text)
})

/** Patches the first central directory entry of a zip() archive. */
function patchCentral(buf: Buffer, fn: (b: Buffer, at: number) => void): Buffer {
  const out = Buffer.from(buf)
  const eocd = out.length - 22
  fn(out, out.readUInt32LE(eocd + 16))
  return out
}

describe('readZip', () => {
  it('round-trips the zip writer', () => {
    const big = 'a'.repeat(10_000)
    const files = readZip(zip([file('p/skill.json', '{}'), file('p/lessons/a.json', big)]))
    expect(files.map((f) => f.name)).toEqual(['p/skill.json', 'p/lessons/a.json'])
    expect(files[1].data.toString()).toBe(big)
  })

  it.each([
    ['../evil.json', 'relative segment'],
    ['p/../../evil.json', 'relative segment'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/evil.json', 'drive'],
    ['p\\..\\evil.json', 'backslash'],
    ['p/con.json', 'reserved'],
    ['p/a:b.json', 'invalid character']
  ])('rejects the unsafe name %s', (name, why) => {
    expect(() => readZip(zip([file(name)]))).toThrow(why)
  })

  it('rejects symbolic links', () => {
    const buf = patchCentral(zip([file('p/link')]), (b, at) => {
      b.writeUInt16LE((3 << 8) | 20, at + 4)
      b.writeUInt32LE((0o120777 << 16) >>> 0, at + 38)
    })
    expect(() => readZip(buf)).toThrow(/symbolic link/)
  })

  it('rejects encrypted entries', () => {
    const buf = patchCentral(zip([file('p/a.json')]), (b, at) =>
      b.writeUInt16LE(b.readUInt16LE(at + 8) | 1, at + 8)
    )
    expect(() => readZip(buf)).toThrow(/encrypted/)
  })

  it('rejects too many entries and too many bytes', () => {
    const many = Array.from({ length: 5 }, (_, i) => file(`p/${i}.json`))
    expect(() => readZip(zip(many), { maxBytes: 1e6, maxEntries: 4 })).toThrow(/too many entries/)
    const big = [file('p/a.json', 'a'.repeat(5000))]
    expect(() => readZip(zip(big), { maxBytes: 4000, maxEntries: 10 })).toThrow(/size limit/)
    expect(() => readZip(Buffer.alloc(200), { maxBytes: 100, maxEntries: 10 })).toThrow(/too large/)
  })

  it('rejects a deflate bomb that lies about its size', () => {
    const buf = patchCentral(zip([file('p/a.json', 'a'.repeat(100_000))]), (b, at) =>
      b.writeUInt32LE(10, at + 24)
    )
    expect(() => readZip(buf)).toThrow(ZipError)
  })

  it('rejects duplicates (case-insensitive) and corrupt data', () => {
    expect(() => readZip(zip([file('p/A.json'), file('p/a.json')]))).toThrow(/duplicate/)
    const buf = patchCentral(zip([file('p/a.json', 'hello')]), (b, at) =>
      b.writeUInt32LE(123, at + 16)
    )
    expect(() => readZip(buf)).toThrow(/corrupt/)
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/not a zip/)
  })

  it('unsafeName accepts plain relative paths', () => {
    expect(unsafeName('blender/lessons/blender-a.lesson.json')).toBeNull()
    expect(unsafeName('dir/')).toBeNull()
  })
})
