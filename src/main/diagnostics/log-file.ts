// Copies everything main prints (console.*) into <logs>/main.log so an installed build, which
// has no console, still leaves a trail for "Export diagnostics". Key-shaped strings and every
// other sensitive span (JWTs, private keys, cards ...) are redacted before they reach the file. Rotates at 5 MB, keeping 5 files.
// Lines are buffered and appended every 250 ms (or at 64 KB), and synchronously on exit.
import {
  appendFile,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { join } from 'path'
import { format } from 'util'
import { redactForLog } from '../actions/redact'

export const LOG_FILE = 'main.log'
const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 5
const FLUSH_MS = 250
const FLUSH_BYTES = 64 * 1024

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/(bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[redacted]'],
  [/((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]']
]

/** Removes API-key-shaped strings, then whatever the shared sensitive-data detector finds. */
export function redact(text: string): string {
  return redactForLog(redactKeys(text))
}

function redactKeys(text: string): string {
  let out = text
  for (const [re, sub] of SECRETS) out = out.replace(re, sub)
  return out
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
let preRedacted = false
let flushNow: (() => void) | null = null

export function logFileDir(): string | null {
  return installedDir
}

/** Prints a line `redactForLog` already ran over; the file tee only adds the key patterns. */
export function printRedacted(line: string): void {
  preRedacted = true
  try {
    console.log(line)
  } finally {
    preRedacted = false
  }
}

/** Writes every buffered line to main.log now (exit, diagnostics export). */
export function flushLogFile(): void {
  flushNow?.()
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
  let queue: string[] = []
  let queued = 0
  let inflight: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const take = (): string => {
    if (timer) clearTimeout(timer)
    timer = null
    const chunk = queue.join('')
    queue = []
    queued = 0
    return chunk
  }
  const reserve = (bytes: number): void => {
    if (size + bytes > MAX_BYTES) {
      rotate(dir)
      size = 0
    }
    size += bytes
  }
  const flush = (): void => {
    if (inflight !== null || !queue.length) return
    const chunk = take()
    try {
      reserve(Buffer.byteLength(chunk))
    } catch {
      /* rotation failed: keep appending to the current file */
    }
    inflight = chunk
    appendFile(file, chunk, () => {
      if (inflight !== chunk) return
      inflight = null
      if (queue.length) schedule()
    })
  }
  const schedule = (): void => {
    if (queued >= FLUSH_BYTES) flush()
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        flush()
      }, FLUSH_MS)
      timer.unref?.()
    }
  }
  flushNow = (): void => {
    let chunk = take()
    if (inflight !== null) {
      const pending = inflight
      inflight = null
      let landed = false
      try {
        landed = readFileSync(file, 'utf8').includes(pending)
      } catch {
        /* unreadable: write it again */
      }
      if (!landed) chunk = pending + chunk
    }
    if (!chunk) return
    try {
      reserve(Buffer.byteLength(chunk))
      appendFileSync(file, chunk)
    } catch {
      /* a full or locked disk must not break quitting */
    }
  }
  const write = (level: string, args: unknown[], clean: boolean): void => {
    try {
      const text = format(...args)
      const body = clean ? redactKeys(text) : redact(text)
      const line = `${new Date().toISOString()} ${level} ${body}\n`
      queue.push(line)
      queued += line.length
      schedule()
    } catch {
      /* a full or locked disk must not break logging to the console */
    }
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      const clean = preRedacted
      preRedacted = false
      original(...args)
      write(level, args, clean)
    }
  }
  process.on('exit', flushLogFile)
  write('info', [`--- Lumen started (pid ${process.pid})`], false)
}
