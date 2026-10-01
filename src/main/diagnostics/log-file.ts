// Copies everything main prints (console.*) into <logs>/main.log so an installed build, which
// has no console, still leaves a trail for "Export diagnostics". Key-shaped strings and every
// other sensitive span (JWTs, private keys, cards ...) are redacted before they reach the file. Rotates at 5 MB, keeping 5 files.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { format } from 'util'
import { redactForLog } from '../actions/redact'

export const LOG_FILE = 'main.log'
const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 5

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/(bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[redacted]'],
  [/((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]']
]

/** Removes API-key-shaped strings, then whatever the shared sensitive-data detector finds. */
export function redact(text: string): string {
  let out = text
  for (const [re, sub] of SECRETS) out = out.replace(re, sub)
  return redactForLog(out)
}

/** main.log → main.1.log → … → main.<KEEP-1>.log; the oldest is dropped. */
export function rotate(dir: string): void {
  const name = (i: number): string => join(dir, i === 0 ? LOG_FILE : `main.${i}.log`)
  rmSync(name(KEEP - 1), { force: true })
  for (let i = KEEP - 2; i >= 0; i--) {
    if (existsSync(name(i))) renameSync(name(i), name(i + 1))
  }
}

let installedDir: string | null = null

export function logFileDir(): string | null {
  return installedDir
}

/** Tees console output into `dir/main.log`. Safe to call once; later calls are ignored. */
export function installLogFile(dir: string): void {
  if (installedDir) return
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  installedDir = dir
  const file = join(dir, LOG_FILE)
  let size = existsSync(file) ? statSync(file).size : 0
  const write = (level: string, args: unknown[]): void => {
    try {
      const line = `${new Date().toISOString()} ${level} ${redact(format(...args))}\n`
      if (size + line.length > MAX_BYTES) {
        rotate(dir)
        size = 0
      }
      appendFileSync(file, line)
      size += Buffer.byteLength(line)
    } catch {
      /* a full or locked disk must not break logging to the console */
    }
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      write(level, args)
    }
  }
  write('info', [`--- Lumen started (pid ${process.pid})`])
}
