// WebP / AVIF / GIF card images (05 T42): format and size from the file header, the draw size
// and the script-less page. The offscreen window itself is a hand test.
import { describe, expect, it } from 'vitest'
import { fitSize, rasterKind, rasterPage, rasterSize } from '../../src/main/cards/raster'

function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(w - 1, 24, 3)
  b.writeUIntLE(h - 1, 27, 3)
  return b
}

function webpVp8l(w: number, h: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8L', 12, 'latin1')
  b[20] = 0x2f
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21)
  return b
}

function webpVp8(w: number, h: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8 ', 12, 'latin1')
  b.set([0x9d, 0x01, 0x2a], 23)
  b.writeUInt16LE(w, 26)
  b.writeUInt16LE(h, 28)
  return b
}

function avif(w: number, h: number): Buffer {
  const head = Buffer.alloc(32)
  head.writeUInt32BE(32, 0)
  head.write('ftypavif', 4, 'latin1')
  head.write('mif1miaf', 16, 'latin1')
  const ispe = Buffer.alloc(20)
  ispe.writeUInt32BE(20, 0)
  ispe.write('ispe', 4, 'latin1')
  ispe.writeUInt32BE(w, 12)
  ispe.writeUInt32BE(h, 16)
  return Buffer.concat([head, Buffer.alloc(40), ispe])
}

function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

describe('raster headers', () => {
  it('knows the formats nativeImage cannot decode', () => {
    expect(rasterKind(webpVp8x(10, 10))).toBe('webp')
    expect(rasterKind(avif(10, 10))).toBe('avif')
    expect(rasterKind(gif(10, 10))).toBe('gif')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(rasterKind(png)).toBeNull()
    expect(rasterKind(Buffer.from('hello'))).toBeNull()
  })

  it('reads the size of each', () => {
    expect(rasterSize(webpVp8x(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(rasterSize(webpVp8l(800, 600))).toEqual({ width: 800, height: 600 })
    expect(rasterSize(webpVp8(640, 427))).toEqual({ width: 640, height: 427 })
    expect(rasterSize(avif(1200, 900))).toEqual({ width: 1200, height: 900 })
    expect(rasterSize(gif(320, 200))).toEqual({ width: 320, height: 200 })
  })

  it('refuses empty, huge or cut headers', () => {
    expect(rasterSize(webpVp8x(1, 1).subarray(0, 20))).toBeNull()
    expect(rasterSize(avif(0, 10))).toBeNull()
    expect(rasterSize(avif(20_000, 10))).toBeNull()
    expect(rasterSize(Buffer.alloc(4))).toBeNull()
  })

  it('draws at most 640 px a side', () => {
    expect(fitSize({ width: 1920, height: 1080 }, 640)).toEqual({ width: 640, height: 360 })
    expect(fitSize({ width: 300, height: 900 }, 640)).toEqual({ width: 213, height: 640 })
    expect(fitSize({ width: 100, height: 50 }, 640)).toEqual({ width: 100, height: 50 })
  })

  it('the page has no scripts and loads only the picture file', () => {
    const page = rasterPage('C:\\tmp\\lumen-card-ab.webp', { width: 64, height: 32 })
    expect(page).toContain("default-src 'none'; img-src file:")
    expect(page).toContain('src="file:///')
    expect(page).toContain('width:64px;height:32px')
    expect(page).not.toMatch(/<script/i)
  })
})
