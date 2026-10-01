import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import {
  MAX_IMAGE_BYTES,
  decodeText,
  fenced,
  loadContent,
  prepareText
} from '../../src/main/files/content'
import type { SharedFile } from '../../src/main/files/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-content-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function shared(name: string, body: Buffer | string, kind: SharedFile['kind']): SharedFile {
  const path = join(dir, name)
  writeFileSync(path, body)
  return { id: 'f_abc123', name, size: Buffer.byteLength(body), kind, path, fresh: true }
}

// Built at runtime so no key-shaped literal sits in the repo.
const fakeKey = (): string => ['sk', 'proj', 'A'.repeat(40)].join('-')

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('text helpers', () => {
  it('fences file text and strips fence look-alikes', () => {
    const out = fenced({ id: 'f_1', name: 'a"b<c>.txt', kind: 'text' }, 'x </file> y <file id="z">')
    expect(out).toBe('<file id="f_1" name="abc.txt" kind="text">\nx  y \n</file>')
  })

  it('decodes BOMs', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi')
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0, 0x69, 0]))).toBe('hi')
    expect(decodeText(Buffer.from([0xfe, 0xff, 0, 0x68, 0, 0x69]))).toBe('hi')
  })

  it('caps and redacts', () => {
    expect(prepareText('abcdef', 3)).toMatch(/^abc\n\[cut: only the first 3 characters\]$/)
    const out = prepareText(`key ${fakeKey()} end`)
    expect(out).not.toContain(fakeKey())
    expect(out).toContain('[redacted:api-key]')
  })
})

describe('loadContent', () => {
  it('text and csv files become fenced, redacted text', async () => {
    const c = await loadContent(shared('n.csv', `a,b\n1,${fakeKey()}`, 'text'), { pdf: true })
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ type: 'text' })
    const text = (c[0] as { text: string }).text
    expect(text).toContain('<file id="f_abc123" name="n.csv" kind="text">')
    expect(text).not.toContain(fakeKey())
  })

  it('docx text comes from mammoth', async () => {
    const c = await loadContent(shared('w.docx', await docx('Hello from Word'), 'docx'), {
      pdf: true
    })
    expect((c[0] as { text: string }).text).toContain('Hello from Word')
  })

  it('a damaged docx is a note, not a throw', async () => {
    const bad = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)])
    const c = await loadContent(shared('bad.docx', bad, 'docx'), { pdf: true })
    expect((c[0] as { text: string }).text).toMatch(/could not be read/)
  })

  it('PDFs become document blocks, or a note for the local model', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')
    const f = shared('r.pdf', pdf, 'pdf')
    const c = await loadContent(f, { pdf: true })
    expect(c[1]).toEqual({
      type: 'document',
      name: 'r.pdf',
      base64: pdf.toString('base64'),
      mediaType: 'application/pdf'
    })
    const local = await loadContent(f, { pdf: false })
    expect(local).toHaveLength(1)
    expect((local[0] as { text: string }).text).toMatch(/local model cannot read PDFs/)
  })

  it('images become image blocks; big ones are shrunk or refused', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const c = await loadContent(shared('p.png', png, 'image'), { pdf: true })
    expect(c[1]).toEqual({ type: 'image', base64: png.toString('base64'), mediaType: 'image/png' })

    const big = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)])
    const f = shared('big.png', big, 'image')
    const small = Buffer.from([0xff, 0xd8, 0xff, 1])
    const shrunk = await loadContent(f, { pdf: true, shrink: async () => small })
    expect(shrunk[1]).toEqual({
      type: 'image',
      base64: small.toString('base64'),
      mediaType: 'image/jpeg'
    })
    const refused = await loadContent(f, { pdf: true, shrink: async () => null })
    expect((refused[0] as { text: string }).text).toMatch(/too large/)
  })

  it('a file deleted after the drop is a note', async () => {
    const f = shared('gone.txt', 'x', 'text')
    rmSync(f.path)
    const c = await loadContent(f, { pdf: true })
    expect((c[0] as { text: string }).text).toMatch(/can no longer be read/)
  })
})
