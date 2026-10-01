import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PassThrough } from 'stream'

// A fake https.request: answers from `routes` (url → status/body/location).
interface Route {
  status: number
  body?: Buffer
  location?: string
}
const routes = new Map<string, Route>()
const requested: string[] = []

vi.mock('https', () => ({
  request: (target: URL, _opts: unknown, cb: (res: unknown) => void) => {
    const url = target.toString()
    requested.push(url)
    const route = routes.get(url) ?? { status: 404 }
    const req = new PassThrough() as PassThrough & { setTimeout: () => void; end: () => void }
    req.setTimeout = () => {}
    req.end = () => {
      const res = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      res.statusCode = route.status
      res.headers = {
        ...(route.location ? { location: route.location } : {}),
        ...(route.body ? { 'content-length': String(route.body.length) } : {})
      }
      setImmediate(() => {
        cb(res)
        res.end(route.body ?? Buffer.alloc(0))
      })
      return req
    }
    return req
  }
}))

import { tempDir } from '../helpers/fixtures'
import {
  checkUrl,
  download,
  installArchive,
  tarPath
} from '../../src/main/downloads/verified-download'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const URL_OK = 'https://github.com/k2-fsa/model.bin'

describe('verified download', () => {
  let tmp: ReturnType<typeof tempDir>
  beforeEach(() => {
    tmp = tempDir()
    routes.clear()
    requested.length = 0
  })
  afterEach(() => tmp.cleanup())

  it('allows only https on allowlisted hosts', () => {
    expect(() => checkUrl('http://github.com/x', ['github.com'])).toThrow(/https/)
    expect(() => checkUrl('https://evil.example/x', ['github.com'])).toThrow(/not allowed/)
    expect(() => checkUrl('not a url', ['github.com'])).toThrow()
    expect(checkUrl('https://GitHub.com/x', ['github.com']).hostname).toBe('github.com')
  })

  it('downloads, follows allowed redirects and verifies the checksum', async () => {
    const body = Buffer.from('model bytes')
    routes.set(URL_OK, { status: 302, location: 'https://objects.githubusercontent.com/a' })
    routes.set('https://objects.githubusercontent.com/a', { status: 200, body })
    const dest = join(tmp.dir, 'm', 'model.bin')
    const progress: number[] = []
    await download({ url: URL_OK, sha256: sha(body), dest, onProgress: (b) => progress.push(b) })
    expect(readFileSync(dest, 'utf8')).toBe('model bytes')
    expect(progress.at(-1)).toBe(body.length)
    expect(readdirSync(join(tmp.dir, 'm'))).toEqual(['model.bin'])
  })

  it('rejects a tampered file and leaves nothing behind', async () => {
    routes.set(URL_OK, { status: 200, body: Buffer.from('tampered') })
    const dest = join(tmp.dir, 'model.bin')
    await expect(download({ url: URL_OK, sha256: sha(Buffer.from('x')), dest })).rejects.toThrow(
      /checksum/
    )
    expect(readdirSync(tmp.dir)).toEqual([])
  })

  it('refuses a redirect to another host or to http', async () => {
    routes.set(URL_OK, { status: 302, location: 'https://evil.example/m' })
    const dest = join(tmp.dir, 'model.bin')
    await expect(download({ url: URL_OK, sha256: 'x', dest })).rejects.toThrow(/not allowed/)
    routes.set(URL_OK, { status: 302, location: 'http://github.com/m' })
    await expect(download({ url: URL_OK, sha256: 'x', dest })).rejects.toThrow(/https/)
    expect(requested).not.toContain('https://evil.example/m')
    expect(existsSync(dest)).toBe(false)
  })

  it('reports HTTP errors and stops redirect loops', async () => {
    const dest = join(tmp.dir, 'model.bin')
    await expect(download({ url: URL_OK, sha256: 'x', dest })).rejects.toThrow(/HTTP 404/)
    routes.set(URL_OK, { status: 302, location: URL_OK })
    await expect(download({ url: URL_OK, sha256: 'x', dest, maxRedirects: 3 })).rejects.toThrow(
      /redirects/
    )
  })

  it('uses the absolute System32 tar on Windows', () => {
    if (process.platform !== 'win32') return
    expect(tarPath().toLowerCase()).toMatch(/\\system32\\tar\.exe$/)
  })

  it.runIf(process.platform === 'win32')(
    'installs an archive with the system tar and swaps it in whole',
    async () => {
      const src = join(tmp.dir, 'src')
      mkdirSync(join(src, 'model-1', 'am'), { recursive: true })
      writeFileSync(join(src, 'model-1', 'am', 'final.mdl'), 'weights')
      const zip = join(tmp.dir, 'model-1.zip')
      execFileSync(tarPath(), ['-a', '-cf', zip, '-C', src, 'model-1'])
      const body = readFileSync(zip)
      const url = 'https://github.com/model-1.zip'
      routes.set(url, { status: 200, body })
      const dest = join(tmp.dir, 'home', 'model')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'old.txt'), 'old')
      const phases: string[] = []
      const spec = {
        url,
        sha256: sha(body),
        rootInArchive: 'model-1',
        requiredFiles: ['am/final.mdl']
      }
      await installArchive(spec, dest, (p) => phases.push(p.phase))
      expect(readFileSync(join(dest, 'am', 'final.mdl'), 'utf8')).toBe('weights')
      expect(existsSync(join(dest, 'old.txt'))).toBe(false)
      expect(phases).toContain('extracting')
      expect(phases.at(-1)).toBe('done')
      expect(readdirSync(join(tmp.dir, 'home', '.downloads'))).toEqual([])

      // A bad checksum keeps the installed model.
      await expect(
        installArchive({ ...spec, sha256: sha(Buffer.from('other')) }, dest, () => {})
      ).rejects.toThrow(/checksum/)
      expect(existsSync(join(dest, 'am', 'final.mdl'))).toBe(true)
    }
  )
})
