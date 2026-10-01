// Draws the tray icons (16-48 px, light and dark taskbar, 4 states) and writes them as .ico
// files next to this script. Run: node resources/tray/generate.mjs
import { writeFileSync } from 'fs'
import { deflateSync } from 'zlib'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const OUT = dirname(fileURLToPath(import.meta.url))
const SIZES = [16, 20, 24, 32, 48]
const SS = 6 // supersamples per axis

// Glyph colour per taskbar: white on a dark taskbar, near-black on a light one.
const INK = { dark: [255, 255, 255], light: [28, 30, 36] }
const BLUE = [61, 139, 255]
const RED = [229, 72, 77]

// Shapes in a 0..1 box. The glyph is a four-point spark (an astroid), the brand mark.
const spark = (cx, cy, r) => (x, y) =>
  Math.abs((x - cx) / r) ** 0.75 + Math.abs((y - cy) / r) ** 0.75 <= 1
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const band = (w) => (x, y) =>
  Math.abs(x - y) / Math.SQRT2 <= w / 2 && (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.2
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1

function layers(state, ink) {
  const full = [{ fn: spark(0.5, 0.5, 0.47), color: ink }]
  const badge = (color, extra = []) => [
    { fn: spark(0.42, 0.42, 0.4), color: ink },
    { fn: disc(0.76, 0.76, 0.27), cut: true },
    { fn: disc(0.76, 0.76, 0.2), color },
    ...extra
  ]
  switch (state) {
    case 'ready':
      return full
    case 'listening':
      return badge(BLUE)
    case 'error':
      return badge(RED, [
        { fn: rect(0.735, 0.62, 0.785, 0.79), color: [255, 255, 255] },
        { fn: disc(0.76, 0.85, 0.03), color: [255, 255, 255] }
      ])
    case 'paused':
      return [
        { fn: spark(0.5, 0.5, 0.47), color: ink },
        { fn: band(0.2), cut: true },
        { fn: band(0.09), color: ink }
      ]
  }
  throw new Error(state)
}

function render(size, ops) {
  const px = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          let c = null
          for (const op of ops) if (op.fn(x, y)) c = op.cut ? null : op.color
          if (c) {
            r += c[0]
            g += c[1]
            b += c[2]
            a++
          }
        }
      }
      const i = (py * size + pxi) * 4
      if (a) {
        px[i] = Math.round(r / a)
        px[i + 1] = Math.round(g / a)
        px[i + 2] = Math.round(b / a)
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return px
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    head[e] = size % 256
    head[e + 1] = size % 256
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((i) => i.data)])
}

for (const state of ['ready', 'listening', 'paused', 'error']) {
  for (const taskbar of ['dark', 'light']) {
    const ops = layers(state, INK[taskbar])
    const images = SIZES.map((size) => ({ size, data: png(size, render(size, ops)) }))
    writeFileSync(join(OUT, `${state}-${taskbar}.ico`), ico(images))
  }
}
console.log('tray icons written to', OUT)
