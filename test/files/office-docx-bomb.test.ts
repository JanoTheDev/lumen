import { describe, expect, it, vi } from 'vitest'

const convertToHtml = vi.fn(async () => ({ value: '<p>ok</p>', messages: [] }))
vi.mock('mammoth', () => ({
  default: { convertToHtml, images: { imgElement: (f: unknown) => f } }
}))

import { checkedDocx, docxText } from '../../src/main/files/office'
import { readZip, ZipError } from '../../src/main/packs/zip-read'
import { writeZip } from '../../src/main/docs-out/zip'

const DOC =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>'

/** Sets the unpacked size of the first entry in both headers (a zip that lies about it). */
function withSize(zip: Buffer, size: number): Buffer {
  const out = Buffer.from(zip)
  out.writeUInt32LE(size, 22)
  const dir = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  out.writeUInt32LE(size, dir + 24)
  return out
}

describe('docx zip limits (review H1)', () => {
  it('a Word file whose document.xml unpacks past the limit never reaches mammoth', async () => {
    convertToHtml.mockClear()
    // 4 MB of zeros, said to unpack to 200 MB: refused from the central directory.
    const big = withSize(
      writeZip([{ name: 'word/document.xml', data: Buffer.alloc(4 * 1024 * 1024) }]),
      200 * 1024 * 1024
    )
    await expect(docxText(big)).rejects.toBeInstanceOf(ZipError)
    expect(convertToHtml).not.toHaveBeenCalled()
  })

  it('a bomb that lies about its size is stopped by the inflate cap', async () => {
    convertToHtml.mockClear()
    const liar = withSize(
      writeZip([{ name: 'word/document.xml', data: Buffer.alloc(8 * 1024 * 1024) }]),
      1000
    )
    await expect(docxText(liar)).rejects.toBeInstanceOf(ZipError)
    expect(convertToHtml).not.toHaveBeenCalled()
  })

  it('a good Word file reaches mammoth rebuilt from the checked entries, images emptied', async () => {
    convertToHtml.mockClear()
    const ok = writeZip([
      { name: 'word/document.xml', data: DOC },
      { name: 'word/media/image1.png', data: Buffer.alloc(1000, 7) }
    ])
    expect(await docxText(ok)).toBe('ok')
    const passed = (convertToHtml.mock.calls[0] as unknown as [{ buffer: Buffer }])[0].buffer
    const names = readZip(passed).map((f) => [f.name, f.data.length])
    expect(names).toEqual([
      ['word/document.xml', Buffer.byteLength(DOC)],
      ['word/media/image1.png', 0]
    ])
    expect(() => checkedDocx(writeZip([{ name: 'a.txt', data: 'x' }]))).toThrow(/Word/)
  })
})
