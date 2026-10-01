// "at file pipeline dot ts" in coding mode (04 T42): a spoken file name → its path in the
// project, so Claude Code and Cursor get a working @-mention. The project is walked once
// (bounded, skipping dependency and build folders) and cached for a minute.
import { readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import type { FileResolver } from './coding'

const MAX_ENTRIES = 20_000
const MAX_DEPTH = 8
const CACHE_MS = 60_000
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'coverage'
])

/** Relative paths of the project's files (forward slashes), bounded. */
export function listProjectFiles(root: string, maxEntries = MAX_ENTRIES): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= maxEntries) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1)
      } else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 0)
  return out
}

/**
 * The one file whose name (or path ending) matches the spoken name, case-insensitive;
 * null when none or several match. Pure.
 */
export function pickFile(name: string, files: readonly string[]): string | null {
  const want = name.toLowerCase().replace(/^\.?\/+/, '')
  if (!want) return null
  const hits = files.filter((f) => {
    const l = f.toLowerCase()
    return l === want || l.endsWith(`/${want}`)
  })
  return hits.length === 1 ? hits[0] : null
}

let cache: { root: string; at: number; files: string[] } | null = null

/** A resolver for one project folder; null without a folder. */
export function projectResolver(
  root: string | undefined,
  now = Date.now()
): FileResolver | undefined {
  if (!root) return undefined
  if (!cache || cache.root !== root || now - cache.at > CACHE_MS)
    cache = { root, at: now, files: listProjectFiles(root) }
  const files = cache.files
  return (name) => pickFile(name, files)
}
