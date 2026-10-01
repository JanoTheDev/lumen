// Card images (05 T38): a remote picture becomes a small local JPEG data URL, so renderers never
// load a remote URL (CSP img-src stays 'self' data:). Fetched through web/net safeGet (https, no
// private hosts, every redirect re-checked), ≤ 3 MB, image/* only, 8 s; decoded and scaled to
// ≤ 640 px by Electron's nativeImage. Kept in memory (LRU 50) and in ~/.ai-overlay/card-images/
// for 7 days, except in private mode. Also: the picture a page names (og:image / twitter:image /
// a large <img>) and a Wikimedia Commons lookup with its credit line.
import { createHash } from 'crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ImageRef } from '@shared/cards'
import { configPath, loadConfig } from '../config'
import { log } from '../logger'
import { decodeEntities, htmlToText, metaContent } from '../web/extract'
import { assertFetchable, safeGet, type SafeGetOptions, type SafeGetResult } from '../web/net'

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024
export const IMAGE_TIMEOUT_MS = 8_000
export const IMAGE_MAX_EDGE = 640
export const IMAGE_MEMORY_ITEMS = 50
export const IMAGE_DISK_TTL_MS = 7 * 24 * 60 * 60_000

export type Get = (url: string, opts: SafeGetOptions) => Promise<SafeGetResult>
/** Decodes an image and returns it as a JPEG no larger than 640 px a side, or null. */
export type Encode = (bytes: Buffer) => Buffer | null | Promise<Buffer | null>

export interface ImageDeps {
  get?: Get
  encode?: Encode
  /** The disk cache folder; null = memory only (private mode). */
  cacheDir?: () => string | null
  now?: () => number
}

async function nativeEncode(bytes: Buffer): Promise<Buffer | null> {
  try {
    const { nativeImage } = await import('electron')
    const img = nativeImage.createFromBuffer(bytes)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (!width || !height) return null
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height))
    const small =
      scale < 1
        ? img.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'good'
          })
        : img
    return small.toJPEG(80)
  } catch {
    return null
  }
}

function defaultCacheDir(): string | null {
  return loadConfig().memory.privateMode ? null : join(dirname(configPath()), 'card-images')
}

const keyOf = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 40)
const dataUrl = (jpeg: Buffer): string => `data:image/jpeg;base64,${jpeg.toString('base64')}`

/** Resolves image URLs to data URLs with a memory LRU and a 7-day disk cache. */
export class CardImages {
  private readonly memory = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  private pruned = false

  constructor(private readonly deps: ImageDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private dir(): string | null {
    return (this.deps.cacheDir ?? defaultCacheDir)()
  }

  private remember(url: string, data: string): void {
    this.memory.delete(url)
    this.memory.set(url, data)
    while (this.memory.size > IMAGE_MEMORY_ITEMS) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }

  /** In the memory cache (tests, diagnostics). */
  has(url: string): boolean {
    return this.memory.has(url)
  }

  /** A JPEG data URL for the image at `url`, or null (blocked, too large, not an image). */
  resolve(url: string, signal?: AbortSignal): Promise<string | null> {
    const hit = this.memory.get(url)
    if (hit) {
      this.remember(url, hit)
      return Promise.resolve(hit)
    }
    const running = this.inflight.get(url)
    if (running) return running
    const p = this.load(url, signal).finally(() => this.inflight.delete(url))
    this.inflight.set(url, p)
    return p
  }

  private async load(url: string, signal?: AbortSignal): Promise<string | null> {
    try {
      assertFetchable(url)
    } catch {
      return null
    }
    const dir = this.dir()
    if (dir) {
      if (!this.pruned) {
        this.pruned = true
        void this.prune(dir)
      }
      const cached = await this.readDisk(dir, url)
      if (cached) {
        const data = dataUrl(cached)
        this.remember(url, data)
        return data
      }
    }
    let jpeg: Buffer | null
    try {
      const res = await (this.deps.get ?? safeGet)(url, {
        signal,
        binary: true,
        maxBytes: IMAGE_MAX_BYTES,
        overflow: 'throw',
        timeoutMs: IMAGE_TIMEOUT_MS,
        // nativeImage decodes JPEG and PNG only.
        accept: 'image/jpeg,image/png;q=0.9,image/*;q=0.5'
      })
      if (res.status < 200 || res.status >= 300) return null
      if (!res.contentType.startsWith('image/') || !res.bytes?.length) return null
      jpeg = await (this.deps.encode ?? nativeEncode)(res.bytes)
    } catch (e) {
      log('fail', `card image not loaded: ${(e as Error).message.slice(0, 120)}`)
      return null
    }
    if (!jpeg?.length) return null
    const data = dataUrl(jpeg)
    this.remember(url, data)
    if (dir) await this.writeDisk(dir, url, jpeg)
    return data
  }

  private async readDisk(dir: string, url: string): Promise<Buffer | null> {
    const file = join(dir, `${keyOf(url)}.jpg`)
    try {
      const s = await stat(file)
      if (this.now() - s.mtimeMs >= IMAGE_DISK_TTL_MS) {
        await unlink(file).catch(() => {})
        return null
      }
      return await readFile(file)
    } catch {
      return null
    }
  }

  private async writeDisk(dir: string, url: string, jpeg: Buffer): Promise<void> {
    const file = join(dir, `${keyOf(url)}.jpg`)
    try {
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, jpeg)
      await rename(tmp, file)
    } catch {
      /* the memory copy is enough */
    }
  }

  /** Deletes cached files older than 7 days. */
  async prune(dir = this.dir()): Promise<number> {
    if (!dir) return 0
    let removed = 0
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }
    for (const name of names) {
      if (!/^[0-9a-f]{40}\.jpg$/.test(name)) continue
      const file = join(dir, name)
      try {
        if (this.now() - (await stat(file)).mtimeMs >= IMAGE_DISK_TTL_MS) {
          await unlink(file)
          removed++
        }
      } catch {
        /* gone already */
      }
    }
    return removed
  }
}

export const cardImages = new CardImages()

// ---- the picture a page names ----

const absolute = (raw: string, base: string): string | null => {
  if (!raw.trim()) return null
  try {
    const u = new URL(decodeEntities(raw.trim()), base)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const attr = (tag: string, name: string): string =>
  new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? ''

/**
 * The page's own picture: og:image (secure_url first), twitter:image, else the first <img> that
 * says it is at least 200 px wide and tall. Alt from og:image:alt / twitter:image:alt / the img
 * alt, else `fallbackAlt`.
 */
export function pageImage(html: string, pageUrl: string, fallbackAlt: string): ImageRef | null {
  const meta = [
    'og:image:secure_url',
    'og:image',
    'og:image:url',
    'twitter:image',
    'twitter:image:src'
  ]
  const metaAlt =
    metaContent(html, 'og:image:alt') || metaContent(html, 'twitter:image:alt') || fallbackAlt
  for (const key of meta) {
    const url = absolute(metaContent(html, key), pageUrl)
    if (url) return { sourceUrl: url, pageUrl, alt: metaAlt.slice(0, 200) }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const w = parseInt(attr(tag, 'width'), 10)
    const h = parseInt(attr(tag, 'height'), 10)
    if (!(w >= 200 && h >= 200)) continue
    const url = absolute(attr(tag, 'src'), pageUrl)
    if (!url) continue
    const alt = decodeEntities(attr(tag, 'alt')).trim() || fallbackAlt
    return { sourceUrl: url, pageUrl, alt: alt.slice(0, 200) }
  }
  return null
}

/** Fetches a page (robots.txt respected) and returns the picture it names. */
export async function imageFromPage(
  pageUrl: string,
  fallbackAlt: string,
  get: Get = safeGet,
  signal?: AbortSignal
): Promise<ImageRef | null> {
  try {
    const res = await get(pageUrl, { signal, robots: true, maxBytes: 1_000_000 })
    if (res.status < 200 || res.status >= 300 || !res.body) return null
    return pageImage(res.body, res.url, fallbackAlt)
  } catch {
    return null
  }
}

// ---- Wikimedia Commons ----

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const firstPage = (j: unknown): Json => {
  const pages = obj(obj(obj(j).query).pages)
  return obj(Object.values(pages)[0])
}

async function getJson(get: Get, url: string, signal?: AbortSignal): Promise<unknown> {
  // The MediaWiki API is meant for programs (robots.txt covers crawlers of /w/), so no robots
  // check here; requests carry Lumen's user agent.
  const res = await get(url, {
    signal,
    accept: 'application/json',
    maxBytes: 500_000,
    timeoutMs: IMAGE_TIMEOUT_MS
  })
  if (res.status !== 200) return null
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}

const plain = (html: string, max: number): string =>
  htmlToText(html).replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * A free picture for a place or thing from Wikimedia Commons: the Wikipedia article's lead image
 * when there is one, else the first Commons file search hit. Comes with a 640 px thumbnail URL
 * and the credit line (author, licence) the card must show.
 */
export async function commonsImage(
  query: string,
  get: Get = safeGet,
  signal?: AbortSignal
): Promise<ImageRef | null> {
  const q = query.trim().slice(0, 200)
  if (!q) return null
  try {
    const wiki = await getJson(
      get,
      `${WIKI_API}?${new URLSearchParams({
        action: 'query',
        format: 'json',
        redirects: '1',
        prop: 'pageimages',
        piprop: 'name',
        titles: q
      })}`,
      signal
    )
    let file = str(firstPage(wiki).pageimage)
    if (file) file = `File:${file}`
    else {
      const search = await getJson(
        get,
        `${COMMONS_API}?${new URLSearchParams({
          action: 'query',
          format: 'json',
          list: 'search',
          srnamespace: '6',
          srlimit: '1',
          srsearch: q
        })}`,
        signal
      )
      const hits = obj(obj(search).query).search
      file = Array.isArray(hits) ? str(obj(hits[0]).title) : ''
    }
    if (!/^File:/.test(file)) return null
    const info = await getJson(
      get,
      `${COMMONS_API}?${new URLSearchParams({
        action: 'query',
        format: 'json',
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
        iiurlwidth: String(IMAGE_MAX_EDGE),
        titles: file
      })}`,
      signal
    )
    const ii = obj((firstPage(info).imageinfo as unknown[] | undefined)?.[0])
    const sourceUrl = str(ii.thumburl) || str(ii.url)
    const pageUrl = str(ii.descriptionurl)
    if (!sourceUrl.startsWith('https://') || !pageUrl.startsWith('https://')) return null
    const meta = obj(ii.extmetadata)
    const field = (k: string, max: number): string => plain(str(obj(meta[k]).value), max)
    const artist = field('Artist', 80)
    const licence = field('LicenseShortName', 40)
    const alt = field('ImageDescription', 200) || q
    const credit = [artist ? `Photo: ${artist}` : 'Photo', licence, 'Wikimedia Commons']
      .filter(Boolean)
      .join(', ')
    return { sourceUrl, pageUrl, alt, attribution: credit }
  } catch {
    return null
  }
}
