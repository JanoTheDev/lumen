import { existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CardImages,
  IMAGE_DISK_TTL_MS,
  IMAGE_MEMORY_ITEMS,
  commonsImage,
  imageFromPage,
  pageImage,
  type Get
} from '../../src/main/cards/images'
import { WebError, type SafeGetResult } from '../../src/main/web/net'
import { tempDir } from '../helpers/fixtures'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

const ok = (url: string, over: Partial<SafeGetResult> = {}): SafeGetResult => ({
  url,
  status: 200,
  contentType: 'image/png',
  body: '',
  cut: false,
  bytes: Buffer.from('PNGDATA'),
  ...over
})

const temps: Array<() => void> = []
afterEach(() => temps.splice(0).forEach((f) => f()))

function setup(opts: { disk?: boolean; now?: () => number; get?: Get } = {}): {
  images: CardImages
  get: ReturnType<typeof vi.fn<Get>>
  encode: ReturnType<typeof vi.fn<() => Buffer>>
  dir: string
} {
  const t = tempDir('lumen-cards-')
  temps.push(t.cleanup)
  const get = vi.fn<Get>(opts.get ?? (async (url: string) => ok(url)))
  const encode = vi.fn<() => Buffer>(() => jpeg)
  const images = new CardImages({
    get,
    encode,
    cacheDir: () => (opts.disk === false ? null : t.dir),
    now: opts.now
  })
  return { images, get, encode, dir: t.dir }
}

describe('card images', () => {
  it('fetches with the image caps and returns a JPEG data URL', async () => {
    const { images, get, encode } = setup()
    const src = await images.resolve('https://img.test/a.png')
    expect(src).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    expect(get).toHaveBeenCalledWith(
      'https://img.test/a.png',
      expect.objectContaining({
        binary: true,
        maxBytes: 3 * 1024 * 1024,
        overflow: 'throw',
        timeoutMs: 8000
      })
    )
    expect(encode).toHaveBeenCalledOnce()
  })

  it('refuses http, private hosts, non-images, errors and undecodable bytes', async () => {
    const { images, get } = setup({
      get: async (url) => {
        if (url.includes('html')) return ok(url, { contentType: 'text/html', bytes: undefined })
        if (url.includes('big')) throw new WebError('E_TOO_LARGE', 'too large', url)
        if (url.includes('404')) return ok(url, { status: 404 })
        return ok(url)
      }
    })
    expect(await images.resolve('http://img.test/a.png')).toBeNull()
    expect(await images.resolve('https://127.0.0.1/a.png')).toBeNull()
    expect(get).not.toHaveBeenCalled()
    expect(await images.resolve('https://img.test/page.html')).toBeNull()
    expect(await images.resolve('https://img.test/big.png')).toBeNull()
    expect(await images.resolve('https://img.test/404.png')).toBeNull()
    const bad = new CardImages({
      get: async (u) => ok(u),
      encode: () => null,
      cacheDir: () => null
    })
    expect(await bad.resolve('https://img.test/a.png')).toBeNull()
  })

  it('keeps 50 in memory, newest used last, and shares one fetch per URL', async () => {
    const { images, get } = setup({ disk: false })
    const [a, b] = await Promise.all([
      images.resolve('https://img.test/0.png'),
      images.resolve('https://img.test/0.png')
    ])
    expect(a).toBe(b)
    expect(get).toHaveBeenCalledTimes(1)
    for (let i = 1; i < IMAGE_MEMORY_ITEMS; i++) await images.resolve(`https://img.test/${i}.png`)
    await images.resolve('https://img.test/0.png') // touch: 1 is now the oldest
    await images.resolve('https://img.test/new.png')
    expect(images.has('https://img.test/0.png')).toBe(true)
    expect(images.has('https://img.test/1.png')).toBe(false)
  })

  it('reads the disk cache for 7 days, then fetches again', async () => {
    let now = Date.now()
    const first = setup({ now: () => now })
    await first.images.resolve('https://img.test/a.png')
    expect(readdirSync(first.dir).filter((n) => n.endsWith('.jpg'))).toHaveLength(1)
    const again = new CardImages({
      get: first.get,
      encode: first.encode,
      cacheDir: () => first.dir,
      now: () => now
    })
    expect(await again.resolve('https://img.test/a.png')).toContain('data:image/jpeg')
    expect(first.get).toHaveBeenCalledTimes(1)
    now += IMAGE_DISK_TTL_MS + 1000
    const later = new CardImages({
      get: first.get,
      encode: first.encode,
      cacheDir: () => first.dir,
      now: () => now
    })
    await later.resolve('https://img.test/a.png')
    expect(first.get).toHaveBeenCalledTimes(2)
  })

  it('writes nothing to disk in private mode', async () => {
    const { images, dir } = setup({ disk: false })
    await images.resolve('https://img.test/a.png')
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('prunes expired files only', async () => {
    const t = tempDir('lumen-cards-')
    temps.push(t.cleanup)
    const name = `${'a'.repeat(40)}.jpg`
    writeFileSync(join(t.dir, name), jpeg)
    writeFileSync(join(t.dir, 'keep.txt'), 'x')
    const images = new CardImages({
      cacheDir: () => t.dir,
      now: () => Date.now() + IMAGE_DISK_TTL_MS + 1000
    })
    expect(await images.prune()).toBe(1)
    expect(existsSync(join(t.dir, name))).toBe(false)
    expect(existsSync(join(t.dir, 'keep.txt'))).toBe(true)
  })
})

describe('page images', () => {
  const base = 'https://news.test/a/story'

  it('prefers og:image, resolves relative URLs and keeps its alt', () => {
    const html = `<meta property="og:image" content="/img/x.jpg"><meta property="og:image:alt" content="A boat">`
    expect(pageImage(html, base, 'Story')).toEqual({
      sourceUrl: 'https://news.test/img/x.jpg',
      pageUrl: base,
      alt: 'A boat'
    })
  })

  it('falls back to twitter:image, then a large img, and skips http', () => {
    const tw = `<meta property="og:image" content="http://x.test/a.jpg"><meta name="twitter:image" content="https://cdn.test/t.png">`
    expect(pageImage(tw, base, 'Story')?.sourceUrl).toBe('https://cdn.test/t.png')
    const img = `<img src="/small.png" width="16" height="16"><img src="big.jpg" alt="Harbour &amp; boats" width="800" height="600">`
    expect(pageImage(img, base, 'Story')).toMatchObject({
      sourceUrl: 'https://news.test/a/big.jpg',
      alt: 'Harbour & boats'
    })
    expect(pageImage('<p>none</p>', base, 'Story')).toBeNull()
  })

  it('reads the page with robots on', async () => {
    const get = vi.fn(async (url: string) =>
      ok(url, {
        contentType: 'text/html',
        bytes: undefined,
        body: '<meta property="og:image" content="https://cdn.test/p.jpg">'
      })
    )
    const ref = await imageFromPage(base, 'Story', get)
    expect(ref?.sourceUrl).toBe('https://cdn.test/p.jpg')
    expect(get).toHaveBeenCalledWith(base, expect.objectContaining({ robots: true }))
  })
})

describe('Wikimedia Commons', () => {
  const json = (url: string, body: unknown): SafeGetResult =>
    ok(url, { contentType: 'application/json', bytes: undefined, body: JSON.stringify(body) })
  const info = {
    query: {
      pages: {
        '7': {
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/a/Nice.jpg',
              thumburl: 'https://upload.wikimedia.org/thumb/a/640px-Nice.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Nice.jpg',
              extmetadata: {
                Artist: { value: '<a href="//x">Jane Doe</a>' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
                ImageDescription: { value: 'Nice seen from <i>Castle Hill</i>' }
              }
            }
          ]
        }
      }
    }
  }

  it('uses the article lead image with its credit line', async () => {
    const urls: string[] = []
    const get: Get = async (url) => {
      urls.push(url)
      if (url.startsWith('https://en.wikipedia.org/'))
        return json(url, { query: { pages: { '1': { pageimage: 'Nice.jpg' } } } })
      return json(url, info)
    }
    const ref = await commonsImage('Nice', get)
    expect(ref).toEqual({
      sourceUrl: 'https://upload.wikimedia.org/thumb/a/640px-Nice.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Nice.jpg',
      alt: 'Nice seen from Castle Hill',
      attribution: 'Photo: Jane Doe, CC BY-SA 4.0, Wikimedia Commons'
    })
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('titles=File%3ANice.jpg')
  })

  it('falls back to a Commons search, and gives up quietly', async () => {
    const get: Get = async (url) => {
      if (url.startsWith('https://en.wikipedia.org/'))
        return json(url, { query: { pages: { '-1': { missing: '' } } } })
      if (url.includes('list=search'))
        return json(url, { query: { search: [{ title: 'File:Nice.jpg' }] } })
      return json(url, info)
    }
    expect((await commonsImage('Nice beach', get))?.pageUrl).toContain('File:Nice.jpg')
    const none: Get = async (url) => json(url, { query: { search: [] } })
    expect(await commonsImage('zzz', none)).toBeNull()
    const broken: Get = async () => {
      throw new Error('offline')
    }
    expect(await commonsImage('Nice', broken)).toBeNull()
  })
})
