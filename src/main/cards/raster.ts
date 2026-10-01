// WebP / AVIF / GIF card images (05 T42): Electron's nativeImage decodes only PNG and JPEG, so
// these are drawn by Chromium itself. The picture (already fetched and size-checked) is written
// to a temp file next to a tiny HTML page and both are loaded in a hidden offscreen window with
// no scripts, its own in-memory session that refuses every request except those two files, and
// no permissions; the painted frame comes back as a NativeImage. One picture at a time, 6 s.
// The header parsers (format and size) are pure and tested; the window part is a hand test.
import { randomBytes } from 'crypto'
import { rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

export type RasterKind = 'webp' | 'avif' | 'gif'

/** The format by magic bytes, for the ones nativeImage cannot decode. */
export function rasterKind(b: Buffer): RasterKind | null {
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp'
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brands = b.toString('latin1', 8, Math.min(b.length, 64))
    if (/avi[fs]/.test(brands)) return 'avif'
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif'
  return null
}

const MAX_SIDE = 16_384

/** Width and height from the file header, or null. */
export function rasterSize(b: Buffer): { width: number; height: number } | null {
  const kind = rasterKind(b)
  let w = 0
  let h = 0
  try {
    if (kind === 'gif') {
      w = b.readUInt16LE(6)
      h = b.readUInt16LE(8)
    } else if (kind === 'webp') {
      const chunk = b.toString('latin1', 12, 16)
      if (chunk === 'VP8X' && b.length >= 30) {
        w = 1 + b.readUIntLE(24, 3)
        h = 1 + b.readUIntLE(27, 3)
      } else if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21)
        w = 1 + (bits & 0x3fff)
        h = 1 + ((bits >> 14) & 0x3fff)
      } else if (chunk === 'VP8 ' && b.length >= 30) {
        w = b.readUInt16LE(26) & 0x3fff
        h = b.readUInt16LE(28) & 0x3fff
      }
    } else if (kind === 'avif') {
      // The first image spatial extents box: 'ispe', version/flags, width, height (big endian).
      const at = b.indexOf('ispe', 0, 'latin1')
      if (at > 0 && b.length >= at + 16) {
        w = b.readUInt32BE(at + 8)
        h = b.readUInt32BE(at + 12)
      }
    }
  } catch {
    return null
  }
  if (!w || !h || w > MAX_SIDE || h > MAX_SIDE) return null
  return { width: w, height: h }
}

/** The size to draw at: the longest side at most `edge` px. */
export function fitSize(
  s: { width: number; height: number },
  edge: number
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(s.width, s.height))
  return {
    width: Math.max(1, Math.round(s.width * scale)),
    height: Math.max(1, Math.round(s.height * scale))
  }
}

/** The page that draws the picture at exactly `size` (no scripts, no margins). */
export function rasterPage(imageFile: string, size: { width: number; height: number }): string {
  const src = pathToFileURL(imageFile).href
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}img{display:block;width:${size.width}px;height:${size.height}px}</style></head><body><img src="${src}" alt=""></body></html>`
}

const PARTITION = 'lumen-card-raster'
const TIMEOUT_MS = 6_000
let sessionReady = false
/** The file URLs the session may load right now. */
const allowed = new Set<string>()
let queue: Promise<unknown> = Promise.resolve()

/**
 * Draws a WebP / AVIF / GIF (first frame) picture at most `edge` px a side and returns it as an
 * Electron NativeImage, or null (unknown format, bad header, timeout, empty frame).
 */
export function rasterize(bytes: Buffer, edge: number): Promise<Electron.NativeImage | null> {
  const run = queue.then(() => draw(bytes, edge).catch(() => null))
  queue = run.catch(() => {})
  return run
}

async function draw(bytes: Buffer, edge: number): Promise<Electron.NativeImage | null> {
  const kind = rasterKind(bytes)
  const size0 = rasterSize(bytes)
  if (!kind || !size0) return null
  const size = fitSize(size0, edge)
  const { BrowserWindow, session } = await import('electron')
  const s = session.fromPartition(PARTITION, { cache: false })
  if (!sessionReady) {
    sessionReady = true
    s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowed.has(d.url) }))
    s.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  }
  const stem = join(tmpdir(), `lumen-card-${randomBytes(6).toString('hex')}`)
  const imageFile = `${stem}.${kind}`
  const pageFile = `${stem}.html`
  const urls = [pathToFileURL(imageFile).href, pathToFileURL(pageFile).href]
  const win = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: s,
      offscreen: true,
      sandbox: true,
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      images: true
    }
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await writeFile(imageFile, bytes)
    await writeFile(pageFile, rasterPage(imageFile, size), 'utf8')
    for (const u of urls) allowed.add(u)
    win.webContents.setFrameRate(1)
    const painted = new Promise<Electron.NativeImage>((resolve) => {
      win.webContents.on('paint', (_e, _dirty, image) => {
        if (!image.isEmpty()) resolve(image)
      })
    })
    const loaded = win.loadURL(urls[1]).then(async () => {
      const shot = await win.webContents.capturePage()
      return shot.isEmpty() ? painted : shot
    })
    const image = await Promise.race([
      loaded,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS)
      })
    ])
    if (!image || image.isEmpty()) return null
    const got = image.getSize()
    // A frame of another size (scale factor) is scaled to the size asked for.
    return got.width === size.width && got.height === size.height ? image : image.resize(size)
  } finally {
    clearTimeout(timer)
    for (const u of urls) allowed.delete(u)
    if (!win.isDestroyed()) win.destroy()
    await rm(imageFile, { force: true }).catch(() => {})
    await rm(pageFile, { force: true }).catch(() => {})
  }
}
