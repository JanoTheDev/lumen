// Downloads a model archive into ~/.ai-overlay, checks its SHA-256 and unpacks it with the
// tar that ships with Windows. Everything is staged next to the destination (same volume),
// so the final move is a plain rename.
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { request } from 'https'
import { dirname, join } from 'path'
import { spawn } from 'child_process'

export interface ArchiveSpec {
  url: string
  sha256: string
  /** Folder inside the archive that becomes `dest`. */
  rootInArchive: string
  /** Files that must exist in the unpacked folder. */
  requiredFiles: string[]
}

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  bytes?: number
  total?: number
  message?: string
}

const IDLE_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

function fetchTo(
  url: string,
  file: string,
  onProgress: (bytes: number, total: number) => void,
  redirects = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too many redirects'))
        const next = new URL(res.headers.location, url).toString()
        fetchTo(next, file, onProgress, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`download failed (HTTP ${status})`))
      }
      const total = Number(res.headers['content-length'] || 0)
      const hash = createHash('sha256')
      const out = createWriteStream(file)
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        hash.update(chunk)
        onProgress(bytes, total)
      })
      res.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => out.close(() => resolve(hash.digest('hex'))))
      res.pipe(out)
    })
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('download timed out')))
    req.on('error', reject)
    req.end()
  })
}

function tarPath(): string {
  if (process.platform !== 'win32') return 'tar'
  // System32 bsdtar unpacks .tar.bz2 and .zip; a Git-for-Windows tar earlier on PATH may not.
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tarPath(), ['-xf', archive, '-C', into], { stdio: 'ignore' })
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
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const staging = join(dirname(dest), '.downloads')
  const name = spec.url.split('/').pop() ?? 'model.tar'
  const archive = join(staging, `${name}.part`)
  const unpackDir = join(staging, `${spec.rootInArchive}-unpack`)
  mkdirSync(staging, { recursive: true })
  rmSync(unpackDir, { recursive: true, force: true })
  try {
    let lastPercent = -1
    onProgress({ phase: 'downloading', percent: 0 })
    const digest = await fetchTo(spec.url, archive, (bytes, total) => {
      const percent = total ? Math.floor((bytes / total) * 100) : 0
      if (percent === lastPercent) return
      lastPercent = percent
      onProgress({ phase: 'downloading', percent, bytes, total })
    })
    if (digest !== spec.sha256) throw new Error('download is corrupt (checksum mismatch)')

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
