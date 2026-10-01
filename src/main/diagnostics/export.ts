// "Export diagnostics…": a zip with the logs, the last few crash dumps, the config without
// keys or personal word lists, and versions. Nothing is sent anywhere; the user picks the file.
import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { release, tmpdir, version as osVersion } from 'os'
import { basename, join } from 'path'
import { configPath } from '../config'
import { getAgent } from '../agent/instance'
import { tarPath } from '../downloads/verified-download'
import { logFileDir, redact } from './log-file'
import { isPortable } from '../first-run/portable'

const MAX_DUMPS = 5
// Hotkeys stay (useful when the hotkey does not fire); key values, word lists and phrases go.
const SENSITIVE_KEY = /api.?key|token|secret|password|dictionary|vocab|phrase/i

/** Deep copy of `value` with sensitive fields replaced and key-shaped strings redacted. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== '' && v != null ? '[redacted]' : redactConfig(v)
    }
    return out
  }
  return typeof value === 'string' ? redact(value) : value
}

function newestFiles(dir: string, ext: string, max: number): string[] {
  if (!existsSync(dir)) return []
  const found: { path: string; mtime: number }[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase().endsWith(ext))
        found.push({ path: p, mtime: statSync(p).mtimeMs })
    }
  }
  walk(dir)
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((f) => f.path)
}

export function versions(): Record<string, string | boolean | null> {
  const agent = getAgent()
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    agentImpl: agent?.impl ?? null,
    agentVersion: agent?.version ?? null,
    os: `${osVersion()} (${release()})`,
    arch: process.arch,
    packaged: app.isPackaged,
    portable: isPortable()
  }
}

function zip(fromDir: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    rmSync(file, { force: true })
    const proc = spawn(tarPath(), ['-a', '-c', '-f', file, '-C', fromDir, '.'], {
      stdio: 'ignore',
      windowsHide: true
    })
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
    proc.on('error', reject)
  })
}

/** Builds the zip at `file`. */
export async function writeDiagnostics(file: string): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), 'lumen-diag-'))
  try {
    const logs = logFileDir()
    if (logs && existsSync(logs)) {
      mkdirSync(join(staging, 'logs'))
      for (const f of readdirSync(logs).filter((n) => n.endsWith('.log'))) {
        writeFileSync(join(staging, 'logs', f), redact(readFileSync(join(logs, f), 'utf8')))
      }
    }
    const dumps = newestFiles(app.getPath('crashDumps'), '.dmp', MAX_DUMPS)
    if (dumps.length) {
      mkdirSync(join(staging, 'crashes'))
      for (const d of dumps) copyFileSync(d, join(staging, 'crashes', basename(d)))
    }
    if (existsSync(configPath())) {
      let config: unknown
      try {
        config = redactConfig(JSON.parse(readFileSync(configPath(), 'utf8')))
      } catch {
        config = { error: 'config.json is not valid JSON' }
      }
      writeFileSync(join(staging, 'config.redacted.json'), JSON.stringify(config, null, 2))
    }
    writeFileSync(join(staging, 'versions.json'), JSON.stringify(versions(), null, 2))
    await zip(staging, file)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Asks where to save, then writes the zip. */
export async function exportDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export diagnostics',
    defaultPath: join(app.getPath('downloads'), `Lumen-diagnostics-${stamp}.zip`),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try {
    await writeDiagnostics(filePath)
    console.log(`[diag] diagnostics written to ${filePath}`)
    return { ok: true, path: filePath }
  } catch (e) {
    console.error('[diag] export failed:', (e as Error).message)
    return { ok: false, error: 'Could not write the diagnostics file.' }
  }
}
