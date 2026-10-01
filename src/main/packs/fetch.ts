// Pack downloads from GitHub (07 T32 / 11 T06): a link the user pastes becomes a direct https
// download (raw file, release asset or repo zip), fetched into memory with the host allowlist
// checked on every redirect hop (downloads/verified-download.ts PACK_HOSTS) and a hard size
// cap. No git, no GitHub API, no account.
import { request } from 'https'
import { checkUrl, PACK_HOSTS } from '../downloads/verified-download'
import { ZIP_LIMITS } from './zip-read'

export interface PackSource {
  /** Direct download address. */
  url: string
  /** Folder inside a repo zip ("tree/<ref>/<path>" links). */
  subpath?: string
  /** A short name for the marker and messages. */
  label: string
}

const SEG = /^[A-Za-z0-9._-]+$/
const PACK_FILE = /\.(lumen|zip)$/i

/** The download for a GitHub link; throws with a plain message for anything else. */
export function githubPackSource(input: string): PackSource {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new Error('that is not a web address')
  }
  if (u.protocol !== 'https:') throw new Error('the address must start with https://')
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('that address is not allowed')
  const label = `${host}${u.pathname}`.slice(0, 200)

  if (host === 'raw.githubusercontent.com' || host === 'codeload.github.com')
    return { url: u.toString(), label }
  if (host !== 'github.com') throw new Error('only GitHub addresses are supported')

  const [owner, repoRaw, kind, ...rest] = parts
  const repo = repoRaw?.replace(/\.git$/, '')
  if (!owner || !repo || !SEG.test(owner) || !SEG.test(repo))
    throw new Error('that GitHub address has no owner and repository')
  const base = `${owner}/${repo}`
  if (!kind) return { url: `https://codeload.github.com/${base}/zip/HEAD`, label: base }
  if ((kind === 'blob' || kind === 'raw') && rest.length >= 2) {
    if (!PACK_FILE.test(rest[rest.length - 1]))
      throw new Error('link a .lumen file, or the repository itself')
    const path = rest.map(encodeURIComponent).join('/')
    return { url: `https://raw.githubusercontent.com/${base}/${path}`, label }
  }
  if (kind === 'releases' && rest[0] === 'download' && rest.length >= 3)
    return { url: u.toString(), label }
  if (kind === 'tree' && rest.length >= 1) {
    const [ref, ...sub] = rest
    return {
      url: `https://codeload.github.com/${base}/zip/${encodeURIComponent(ref)}`,
      ...(sub.length ? { subpath: sub.join('/') } : {}),
      label
    }
  }
  throw new Error('link a .lumen file, a release download or the repository itself')
}

export interface FetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  hosts?: readonly string[]
  signal?: AbortSignal
}

/** GETs `url` into memory; https and allowlisted hosts only, on every hop. */
export function fetchPack(url: string, opts: FetchOptions = {}, hop = 0): Promise<Buffer> {
  const max = opts.maxBytes ?? ZIP_LIMITS.maxBytes
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = checkUrl(url, opts.hosts ?? PACK_HOSTS)
    } catch (e) {
      return reject(e)
    }
    const req = request(target, { method: 'GET', signal: opts.signal }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (hop >= (opts.maxRedirects ?? 5)) return reject(new Error('too many redirects'))
        const next = new URL(res.headers.location, target).toString()
        fetchPack(next, opts, hop + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`download failed (HTTP ${status})`))
      }
      if (Number(res.headers['content-length'] || 0) > max) {
        res.destroy()
        return reject(new Error('the pack is larger than 50 MB'))
      }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (c: Buffer) => {
        bytes += c.length
        if (bytes > max) {
          res.destroy()
          reject(new Error('the pack is larger than 50 MB'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('download interrupted')))
    })
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('download timed out')))
    req.on('error', (e: Error) =>
      reject(opts.signal?.aborted ? new Error('download cancelled') : e)
    )
    req.end()
  })
}
