// Verified downloads for models fetched at runtime: HTTPS only, allowlisted hosts on every
// redirect hop, idle timeout, abortable, SHA-256 checked while streaming. Files are staged
// next to the destination (same volume) so the final move is a plain rename, and archives are
// unpacked with the tar that ships with Windows, never one found on PATH.
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, type WriteStream } from 'fs'
import { request } from 'https'
import { dirname, join } from 'path'
import { spawn } from 'child_process'

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  bytes?: number
  total?: number
  message?: string
}

/** Hosts models come from (GitHub release assets redirect to githubusercontent). */
export const MODEL_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'alphacephei.com'
]

export interface DownloadOptions {
  url: string
  sha256: string
  dest: string
  hosts?: readonly string[]
  /** Fails when no bytes arrive for this long. */
  timeoutMs?: number
  maxRedirects?: number
  onProgress?: (bytes: number, total: number) => void
  signal?: AbortSignal
}

export interface ArchiveSpec {
  url: string
  sha256: string
  /** Folder inside the archive that becomes `dest`. */
  rootInArchive: string
  /** Files that must exist in the unpacked folder. */
  requiredFiles: string[]
  hosts?: readonly string[]
}

const IDLE_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

/** Throws unless `url` is https on an allowlisted host. */
export function checkUrl(url: string, hosts: readonly string[]): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('download address is not valid')
  }
  if (u.protocol !== 'https:') throw new Error('download must use https')
  if (!hosts.includes(u.hostname.toLowerCase())) {
    throw new Error(`download host ${u.hostname} is not allowed`)
  }
  return u
}

function fetchTo(file: string, url: string, opts: DownloadOptions, hop: number): Promise<string> {
  const hosts = opts.hosts ?? MODEL_HOSTS
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = checkUrl(url, hosts)
    } catch (e) {
      return reject(e)
    }
    if (opts.signal?.aborted) return reject(new Error('download cancelled'))
    let out: WriteStream | null = null
    // The .part file is removed right after this rejects: close its handle first (Windows
    // cannot delete a file that is still open).
    const fail = (e: Error): void => {
      const o = out
      if (!o || o.closed) return reject(e)
      o.once('close', () => reject(e))
      o.destroy()
    }
    const req = request(target, { method: 'GET', signal: opts.signal }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (hop >= (opts.maxRedirects ?? MAX_REDIRECTS)) {
          return reject(new Error('too many redirects'))
        }
        const next = new URL(res.headers.location, target).toString()
        fetchTo(file, next, opts, hop + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`download failed (HTTP ${status})`))
      }
      const total = Number(res.headers['content-length'] || 0)
      const hash = createHash('sha256')
      const stream = createWriteStream(file)
      out = stream
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        hash.update(chunk)
        opts.onProgress?.(bytes, total)
      })
      res.on('error', fail)
      res.on('aborted', () => fail(new Error('download interrupted')))
      stream.on('error', fail)
      stream.on('finish', () => stream.close(() => resolve(hash.digest('hex'))))
      res.pipe(stream)
    })
    req.setTimeout(opts.timeoutMs ?? IDLE_TIMEOUT_MS, () =>
      req.destroy(new Error('download timed out'))
    )
    req.on('error', (e: Error) => fail(opts.signal?.aborted ? new Error('download cancelled') : e))
    req.end()
  })
}

/** Downloads `url` to `dest` and checks its SHA-256. On any failure nothing is left at `dest`. */
export async function download(opts: DownloadOptions): Promise<void> {
  const part = `${opts.dest}.part`
  mkdirSync(dirname(opts.dest), { recursive: true })
  try {
    const digest = await fetchTo(part, opts.url, opts, 0)
    if (digest !== opts.sha256.toLowerCase()) {
      throw new Error('download is corrupt (checksum mismatch)')
    }
    rmSync(opts.dest, { force: true })
    renameSync(part, opts.dest)
  } finally {
    rmSync(part, { force: true })
  }
}

export function tarPath(): string {
  if (process.platform !== 'win32') return '/usr/bin/tar'
  // System32 bsdtar unpacks .tar.bz2 and .zip; a Git-for-Windows tar earlier on PATH may not.
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tarPath(), ['-xf', archive, '-C', into], {
      stdio: 'ignore',
      windowsHide: true
    })
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
    proc.on('error', reject)
  })
}

export function hasFiles(dir: string, files: string[]): boolean {
  return files.every((f) => existsSync(join(dir, f)))
}

/** Installs `spec` at `dest`. Throws on network, checksum or unpack failure; `dest` is untouched then. */
export async function installArchive(
  spec: ArchiveSpec,
  dest: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const staging = join(dirname(dest), '.downloads')
  const name = spec.url.split('/').pop() ?? 'model.tar'
  const archive = join(staging, name)
  const unpackDir = join(staging, `${spec.rootInArchive}-unpack`)
  rmSync(unpackDir, { recursive: true, force: true })
  try {
    let lastPercent = -1
    onProgress({ phase: 'downloading', percent: 0 })
    await download({
      url: spec.url,
      sha256: spec.sha256,
      dest: archive,
      hosts: spec.hosts,
      signal,
      onProgress: (bytes, total) => {
        const percent = total ? Math.floor((bytes / total) * 100) : 0
        if (percent === lastPercent) return
        lastPercent = percent
        onProgress({ phase: 'downloading', percent, bytes, total })
      }
    })

    onProgress({ phase: 'extracting' })
    mkdirSync(unpackDir, { recursive: true })
    await untar(archive, unpackDir)
    const unpacked = join(unpackDir, spec.rootInArchive)
    if (!hasFiles(unpacked, spec.requiredFiles)) throw new Error('archive is missing model files')

    rmSync(dest, { recursive: true, force: true })
    renameSync(unpacked, dest)
    onProgress({ phase: 'done' })
  } finally {
    rmSync(archive, { force: true })
    rmSync(unpackDir, { recursive: true, force: true })
  }
}
