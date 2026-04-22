import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { spawn } from 'child_process'
import { request } from 'https'
import { BrowserWindow } from 'electron'
import { log } from './logger'

const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip'
const MODEL_NAME = 'vosk-model-small-en-us-0.15'

export function modelRoot(): string {
  return join(homedir(), '.ai-overlay', 'vosk-model')
}

export function modelInstalled(): boolean {
  const root = modelRoot()
  if (!existsSync(root)) return false
  try {
    const entries = readdirSync(root)
    // expect subdirs like 'am', 'conf', 'graph'
    return entries.includes('am') || entries.includes('conf') || entries.some(e => existsSync(join(root, e, 'am')))
  } catch {
    return false
  }
}

let inProgress = false

export interface ProgressEvent {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  bytes?: number
  total?: number
  message?: string
}

function broadcast(evt: ProgressEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('wake-model-progress', evt)
  }
}

async function download(url: string, dest: string, onProgress: (p: { bytes: number; total: number }) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest, onProgress).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let bytes = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; onProgress({ bytes, total }) })
      res.pipe(out)
      out.on('finish', () => { out.close(() => resolve()) })
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function extract(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Windows 10+ tar.exe handles zip natively. macOS/Linux also ship tar.
    const proc = spawn('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' })
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)))
    proc.on('error', reject)
  })
}

export async function installModel(): Promise<void> {
  if (inProgress) return
  if (modelInstalled()) { broadcast({ phase: 'done' }); return }
  inProgress = true
  const root = modelRoot()
  const parent = join(homedir(), '.ai-overlay')
  const tmpZip = join(tmpdir(), 'ai-overlay-vosk.zip')
  const stagingDir = join(tmpdir(), 'ai-overlay-vosk-extract')

  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true })

    log('step',`downloading Vosk model to ${tmpZip}`)
    broadcast({ phase: 'downloading', percent: 0 })
    await download(MODEL_URL, tmpZip, ({ bytes, total }) => {
      const percent = total ? Math.round((bytes / total) * 100) : 0
      broadcast({ phase: 'downloading', percent, bytes, total })
    })

    const size = statSync(tmpZip).size
    log('step',`downloaded ${size} bytes, extracting`)
    broadcast({ phase: 'extracting' })
    await extract(tmpZip, stagingDir)

    const extracted = join(stagingDir, MODEL_NAME)
    if (!existsSync(extracted)) throw new Error(`expected ${extracted} after extraction`)

    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    renameSync(extracted, root)
    try { rmSync(tmpZip, { force: true }) } catch { /* noop */ }
    try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* noop */ }

    log('done', `Vosk model installed at ${root}`)
    broadcast({ phase: 'done' })
  } catch (e) {
    const message = (e as Error).message
    log('fail', `Vosk model install failed: ${message}`)
    broadcast({ phase: 'error', message })
    throw e
  } finally {
    inProgress = false
  }
}
