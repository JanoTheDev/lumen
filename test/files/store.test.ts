import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_FILES,
  checkDroppedPath,
  clearFiles,
  contentMatches,
  getFile,
  listFiles,
  registerFile,
  removeFile
} from '../../src/main/files/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-files-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])

function file(name: string, body: Buffer | string): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

beforeEach(() => clearFiles())

describe('checkDroppedPath', () => {
  it('accepts every allowed type with matching content', async () => {
    const cases: [string, Buffer | string, string][] = [
      ['a.pdf', PDF, 'pdf'],
      ['b.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'docx'],
      ['c.txt', 'hello', 'text'],
      ['d.md', '# title', 'text'],
      ['e.csv', 'a,b\n1,2', 'text'],
      ['f.png', PNG, 'image'],
      ['g.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image'],
      ['h.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image']
    ]
    for (const [name, body, kind] of cases) {
      const r = await checkDroppedPath(file(name, body))
      expect(r, name).toMatchObject({ ok: true, kind, name })
    }
  })

  it('refuses other types, renamed binaries, folders, empty and huge files', async () => {
    const refused = async (p: string): Promise<string> => {
      const r = await checkDroppedPath(p)
      expect(r.ok, p).toBe(false)
      return r.ok ? '' : r.error
    }
    expect(await refused(file('x.exe', EXE))).toMatch(/PDF, Word/)
    expect(await refused(file('y.js', 'alert(1)'))).toMatch(/PDF, Word/)
    expect(await refused(file('renamed.pdf', EXE))).toMatch(/does not look like/)
    expect(await refused(file('bin.txt', EXE))).toMatch(/does not look like/)
    expect(await refused(file('fake.png', 'not a png'))).toMatch(/does not look like/)
    expect(await refused(file('empty.txt', ''))).toMatch(/empty/)
    const big = file('big.txt', 'x')
    truncateSync(big, 50 * 1024 * 1024 + 1)
    expect(await refused(big)).toMatch(/50 MB/)
    const folder = join(dir, 'folder.pdf')
    mkdirSync(folder)
    expect(await refused(folder)).toMatch(/not a file/)
    expect(await refused(join(dir, 'missing.pdf'))).toMatch(/could not find/)
    expect(await refused('relative.pdf')).toMatch(/not a file path/)
    expect(await refused('\\\\server\\share\\a.pdf')).toMatch(/Network/)
    expect(await refused('//server/share/a.pdf')).toMatch(/Network/)
    expect(await refused('C:\\a\0.pdf')).toMatch(/not a file path/)
  })

  it('accepts UTF-16 text with a BOM', () => {
    expect(contentMatches('text', '.txt', Buffer.from([0xff, 0xfe, 0x68, 0]))).toBe(true)
    expect(contentMatches('text', '.txt', Buffer.from([0x68, 0, 0x69, 0]))).toBe(false)
  })
})

describe('registry', () => {
  it('registers once per real path, lists views without the path, removes and clears', async () => {
    const p = file('report.pdf', PDF)
    const a = await registerFile(p)
    const b = await registerFile(p)
    expect(a.ok && b.ok && a.file.id === b.file.id).toBe(true)
    const list = listFiles()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      id: expect.stringMatching(/^f_[a-f0-9]{10}$/),
      name: 'report.pdf',
      size: PDF.length,
      kind: 'pdf'
    })
    expect(JSON.stringify(list)).not.toContain(dir)
    expect(getFile(list[0].id)?.fresh).toBe(true)
    expect(removeFile(list[0].id)).toBe(true)
    expect(removeFile(list[0].id)).toBe(false)
    await registerFile(p)
    clearFiles()
    expect(listFiles()).toEqual([])
  })

  it(`holds at most ${MAX_FILES} files`, async () => {
    for (let i = 0; i < MAX_FILES; i++)
      expect((await registerFile(file(`n${i}.txt`, 'x'))).ok).toBe(true)
    const r = await registerFile(file('one-more.txt', 'x'))
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Up to 5/) })
  })
})
