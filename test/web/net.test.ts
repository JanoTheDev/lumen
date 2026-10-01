import { describe, expect, it } from 'vitest'
import { safeGet, WebError, type FetchImpl, type RobotsCache } from '../../src/main/web/net'

const res = (status: number, body = '', headers: Record<string, string> = {}): Response =>
  new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers: { 'content-type': 'text/html', ...headers }
  })

describe('safeGet', () => {
  it('cuts or throws past the size cap', async () => {
    const impl: FetchImpl = async () => res(200, 'x'.repeat(100))
    const cut = await safeGet('https://a.test/', { fetch: impl, maxBytes: 10 })
    expect(cut.body).toBe('x'.repeat(10))
    expect(cut.cut).toBe(true)
    await expect(
      safeGet('https://a.test/', { fetch: impl, maxBytes: 10, overflow: 'throw' })
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' })
  })

  it('does not read non-text bodies', async () => {
    const impl: FetchImpl = async () => res(200, 'PNG', { 'content-type': 'image/png' })
    const r = await safeGet('https://a.test/x.png', { fetch: impl })
    expect(r).toMatchObject({ body: '', contentType: 'image/png', status: 200 })
  })

  it('stops after five redirects', async () => {
    let n = 0
    const impl: FetchImpl = async () => res(302, '', { location: `/r${n++}` })
    const e = await safeGet('https://a.test/', { fetch: impl }).catch((x) => x)
    expect(e).toBeInstanceOf(WebError)
    expect(e.code).toBe('E_REDIRECTS')
  })

  it('checks robots per host and remembers the verdict', async () => {
    const calls: string[] = []
    const impl: FetchImpl = async (url) => {
      calls.push(url)
      if (url === 'https://a.test/robots.txt')
        return res(200, 'User-agent: lumen\nDisallow: /private', { 'content-type': 'text/plain' })
      return res(200, '<p>ok</p>')
    }
    const cache: RobotsCache = new Map()
    expect(
      (await safeGet('https://a.test/news', { fetch: impl, robots: true, robotsCache: cache })).body
    ).toBe('<p>ok</p>')
    await safeGet('https://a.test/news', { fetch: impl, robots: true, robotsCache: cache })
    expect(calls.filter((c) => c.endsWith('robots.txt'))).toHaveLength(1)
    await expect(
      safeGet('https://a.test/private/x', { fetch: impl, robots: true, robotsCache: cache })
    ).rejects.toMatchObject({ code: 'E_ROBOTS' })
  })

  it('a robots.txt redirect to a private host means no', async () => {
    const impl: FetchImpl = async (url) =>
      url.endsWith('/robots.txt')
        ? res(301, '', { location: 'https://10.0.0.1/robots.txt' })
        : res(200, '<p>x</p>')
    await expect(safeGet('https://a.test/', { fetch: impl, robots: true })).rejects.toMatchObject({
      code: 'E_ROBOTS'
    })
  })

  it('refuses http, credentials and private hosts before any request', async () => {
    const impl: FetchImpl = async () => {
      throw new Error('no request expected')
    }
    await expect(safeGet('http://a.test/', { fetch: impl })).rejects.toThrow(/https/)
    await expect(safeGet('https://u:p@a.test/', { fetch: impl })).rejects.toThrow(/credentials/)
    await expect(safeGet('https://192.168.1.4/', { fetch: impl })).rejects.toThrow(/local/)
  })
})
