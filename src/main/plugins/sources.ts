// Where plugins come from: a GitHub link (packs/fetch: https, host allowlist on every redirect,
// 50 MB; packs/zip-read: strict zip checks), a local folder, or the user's own Claude Code
// setup in ~/.claude (skills/, commands/, output-styles/ and the installed plugins listed in
// plugins/installed_plugins.json). Folder reads have the same limits as a zip: at most 2000
// files and 50 MB, no symlinks or junctions, hidden folders and node_modules skipped. No Electron.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import type { ClaudeHomeScan } from '@shared/plugins'
import { fetchPack, githubPackSource } from '../packs/fetch'
import { readZip, ZIP_LIMITS } from '../packs/zip-read'
import { stripTop, under, type TreeFile } from './layout'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'target'
])
/** Hidden names a plugin needs. */
const KEEP_HIDDEN = new Set(['.claude-plugin', '.mcp.json', '.lsp.json'])

export class SourceError extends Error {}

/** Every file under `dir` (forward-slash names), within the zip limits. */
export function readTree(dir: string, limits = ZIP_LIMITS, prefix = ''): TreeFile[] {
  const out: TreeFile[] = []
  let bytes = 0
  const walk = (d: string, depth: number): void => {
    if (depth > 10) return
    let names: string[]
    try {
      names = readdirSync(d).sort()
    } catch {
      return
    }
    for (const n of names) {
      if ((n.startsWith('.') && !KEEP_HIDDEN.has(n)) || SKIP_DIRS.has(n)) continue
      const p = join(d, n)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      if (out.length >= limits.maxEntries)
        throw new SourceError('the folder has more than 2000 files')
      bytes += st.size
      if (bytes > limits.maxBytes) throw new SourceError('the folder is larger than 50 MB')
      const rel = relative(dir, p).replace(/\\/g, '/')
      out.push({ name: `${prefix}${rel}`, data: readFileSync(p) })
    }
  }
  walk(dir, 0)
  return out
}

export interface ReadSource {
  files: TreeFile[]
  /** Kept in the installed skills' marker and used for the trust pin. */
  source: string
}

/** A GitHub repository, folder (tree link) or zip link. */
export async function readGithub(url: string): Promise<ReadSource> {
  let src: ReturnType<typeof githubPackSource>
  try {
    src = githubPackSource(url)
  } catch (e) {
    throw new SourceError((e as Error).message)
  }
  const archive = await fetchPack(src.url)
  let files: TreeFile[]
  try {
    files = stripTop(readZip(archive, ZIP_LIMITS))
  } catch (e) {
    throw new SourceError(`not a usable download: ${(e as Error).message}`)
  }
  if (src.subpath) files = under(files, src.subpath)
  if (!files.length) throw new SourceError('that folder is empty or missing')
  return { files, source: `${src.url}${src.subpath ? `#${src.subpath}` : ''}` }
}

export function readFolder(dir: string): ReadSource {
  return { files: readTree(dir), source: `folder:${dir}` }
}

/** Installed plugin folders from installed_plugins.json ({name@market: [{installPath}]}). */
export function installedPlugins(home: string): { name: string; dir: string }[] {
  const file = join(home, 'plugins', 'installed_plugins.json')
  if (!existsSync(file)) return []
  const out: { name: string; dir: string }[] = []
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'installPath' && typeof x === 'string')
          out.push({ name: key.split('@')[0], dir: x })
        else walk(x, k.includes('@') ? k : key)
      }
  }
  try {
    walk(JSON.parse(readFileSync(file, 'utf8')), '')
  } catch {
    return []
  }
  const seen = new Set<string>()
  return out.filter((p) => {
    if (!p.name || seen.has(p.name) || !existsSync(p.dir)) return false
    seen.add(p.name)
    return true
  })
}

/**
 * ~/.claude as trees: one "my-claude-code" plugin (skills/, commands/, output-styles/) and one
 * tree per installed plugin. settings.json (with its hooks) is never read.
 */
export function readClaudeHome(home: string): { trees: { label: string; files: TreeFile[] }[] } {
  const own: TreeFile[] = []
  for (const sub of ['skills', 'commands', 'output-styles']) {
    const dir = join(home, sub)
    if (existsSync(dir)) own.push(...readTree(dir, ZIP_LIMITS, `${sub}/`))
  }
  const trees: { label: string; files: TreeFile[] }[] = []
  if (own.length) trees.push({ label: 'my-claude-code', files: own })
  for (const p of installedPlugins(home)) {
    try {
      trees.push({ label: p.name, files: readTree(p.dir) })
    } catch {
      // Too large or unreadable: left out.
    }
  }
  return { trees }
}

function count(dir: string, test: (name: string, isDir: boolean) => boolean): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => test(d.name, d.isDirectory()))
      .length
  } catch {
    return 0
  }
}

/** What ~/.claude holds, without reading file contents. */
export function scanClaudeHome(home: string): ClaudeHomeScan {
  const skills = count(
    join(home, 'skills'),
    (n, d) => d && existsSync(join(home, 'skills', n, 'SKILL.md'))
  )
  const commands = count(join(home, 'commands'), (n, d) => !d && n.toLowerCase().endsWith('.md'))
  const outputStyles = count(
    join(home, 'output-styles'),
    (n, d) => !d && n.toLowerCase().endsWith('.md')
  )
  const plugins = installedPlugins(home).length
  return {
    found: skills + commands + outputStyles + plugins > 0,
    skills,
    commands,
    outputStyles,
    plugins
  }
}
